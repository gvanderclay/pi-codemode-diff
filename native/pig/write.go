package pig

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unicode/utf8"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// Reservations are made by tool_execution_start, before handler goroutines can
// reorder filesystem work. A skipped/cancelled reservation cannot release a
// later writer past an earlier writer that is still running.
type mutationQueue struct {
	mu    sync.Mutex
	paths map[string][]*mutationTicket
}
type mutationTicket struct {
	queue               *mutationQueue
	key                 string
	ready               chan struct{}
	admitted, completed bool
}

func (q *mutationQueue) reserve(path string) (*mutationTicket, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	key, err := filepath.EvalSymlinks(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, syscall.ENOTDIR) {
			return nil, err
		}
		key = path
	}
	if q.paths == nil {
		q.paths = map[string][]*mutationTicket{}
	}
	ticket := &mutationTicket{queue: q, key: key, ready: make(chan struct{})}
	if len(q.paths[key]) == 0 {
		close(ticket.ready)
		ticket.admitted = true
	}
	q.paths[key] = append(q.paths[key], ticket)
	return ticket, nil
}
func (t *mutationTicket) release() {
	q := t.queue
	q.mu.Lock()
	defer q.mu.Unlock()
	if t.completed {
		return
	}
	t.completed = true
	list := q.paths[t.key]
	for len(list) > 0 && list[0].completed {
		list = list[1:]
	}
	if len(list) == 0 {
		delete(q.paths, t.key)
		return
	}
	q.paths[t.key] = list
	if !list[0].admitted {
		close(list[0].ready)
		list[0].admitted = true
	}
}
func (t *mutationTicket) run(done <-chan struct{}, cancelled func() error, fn func() error) error {
	defer t.release()
	select {
	case <-t.ready:
	case <-done:
		return errors.New("Operation aborted")
	}
	if cancelled() != nil {
		return errors.New("Operation aborted")
	}
	return fn()
}

type preparedMutation struct {
	path   string
	ticket *mutationTicket
	err    error
}
type fileTools struct {
	capture *capture
	queue   mutationQueue
	mu      sync.Mutex
	pending map[string]preparedMutation
}

func newFileTools(c *capture) *fileTools {
	return &fileTools{capture: c, pending: map[string]preparedMutation{}}
}
func (w *fileTools) prepare(id, cwd string, input map[string]any) {
	if _, ok := input["path"].(string); !ok {
		return
	}
	path, err := resolvePath(cwd, str(input, "path"))
	var ticket *mutationTicket
	if err == nil {
		ticket, err = w.queue.reserve(path)
	}
	w.mu.Lock()
	w.pending[id] = preparedMutation{path, ticket, err}
	w.mu.Unlock()
}
func (w *fileTools) finish(id string) {
	w.mu.Lock()
	prepared := w.pending[id]
	delete(w.pending, id)
	w.mu.Unlock()
	if prepared.ticket != nil {
		prepared.ticket.release()
	}
}
func (w *fileTools) clear() {
	w.mu.Lock()
	pending := w.pending
	w.pending = map[string]preparedMutation{}
	w.mu.Unlock()
	for _, prepared := range pending {
		if prepared.ticket != nil {
			prepared.ticket.release()
		}
	}
}

// A tool_call hook may rewrite its path after tool_execution_start. Honor the
// actual target and release the stale reservation before taking the new one.
func (w *fileTools) execution(ctx sdk.Context, input map[string]any) (preparedMutation, error) {
	actual, err := resolvePath(ctx.Cwd(), str(input, "path"))
	if err != nil {
		return preparedMutation{}, err
	}
	w.mu.Lock()
	prepared, ok := w.pending[ctx.ToolCallID()]
	w.mu.Unlock()
	if !ok || actual != prepared.path {
		w.finish(ctx.ToolCallID())
		w.prepare(ctx.ToolCallID(), ctx.Cwd(), input)
		w.mu.Lock()
		prepared = w.pending[ctx.ToolCallID()]
		w.mu.Unlock()
	}
	if prepared.err != nil {
		w.finish(ctx.ToolCallID())
		return preparedMutation{}, fsError(prepared.err, "realpath", actual)
	}
	return prepared, nil
}

func snapshot(path string, skip bool) beforeWrite {
	// Stat first keeps FIFOs and device nodes from blocking an open. Recheck the
	// opened descriptor before reading; read limit+1 bytes if a file grows.
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return beforeWrite{kind: "missing"}
	}
	if err != nil {
		return beforeWrite{kind: "unavailable", reason: "Previous content could not be read; text diff unavailable."}
	}
	if !info.Mode().IsRegular() {
		return beforeWrite{kind: "unavailable", reason: "Previous content is not a regular file; text diff unavailable."}
	}
	file, err := os.Open(path)
	if err != nil {
		return beforeWrite{kind: "unavailable", reason: "Previous content could not be read; text diff unavailable."}
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil {
		return beforeWrite{kind: "unavailable", reason: "Previous content could not be read; text diff unavailable."}
	}
	if !info.Mode().IsRegular() {
		return beforeWrite{kind: "unavailable", reason: "Previous content is not a regular file; text diff unavailable."}
	}
	if skip || info.Size() > maxTextBytes {
		return beforeWrite{kind: "omitted", size: info.Size()}
	}
	data, err := io.ReadAll(io.LimitReader(file, maxTextBytes+1))
	if err != nil {
		return beforeWrite{kind: "unavailable", reason: "Previous content could not be read; text diff unavailable."}
	}
	if len(data) > maxTextBytes {
		size := int64(len(data))
		if info, err := file.Stat(); err == nil {
			size = info.Size()
		}
		return beforeWrite{kind: "omitted", size: size}
	}
	text := string(data)
	if strings.ContainsRune(text, 0) {
		return beforeWrite{kind: "unavailable", reason: "Previous content is binary; text diff unavailable."}
	}
	if !utf8.Valid(data) {
		return beforeWrite{kind: "unavailable", reason: "Previous content is not UTF-8; text diff unavailable."}
	}
	if !textFits(text, maxTextBytes, maxTextLines) {
		return beforeWrite{kind: "omitted", size: int64(len(data))}
	}
	return beforeWrite{kind: "text", content: text}
}

func resolvePath(cwd, path string) (string, error) {
	path = strings.TrimPrefix(path, "@")
	path = strings.Map(func(r rune) rune {
		switch {
		case r == '\u00a0', r >= '\u2000' && r <= '\u200a', r == '\u202f', r == '\u205f', r == '\u3000':
			return ' '
		}
		return r
	}, path)
	if path == "~" || strings.HasPrefix(path, "~/") || runtime.GOOS == "windows" && strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if path == "~" {
			path = home
		} else {
			path = filepath.Join(home, path[2:])
		}
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	return filepath.Abs(path)
}

func fsError(err error, operation, path string) error {
	code, description := "UNKNOWN", "unknown error"
	switch {
	case errors.Is(err, os.ErrNotExist):
		code, description = "ENOENT", "no such file or directory"
	case errors.Is(err, os.ErrPermission):
		code, description = "EACCES", "permission denied"
	case errors.Is(err, syscall.EISDIR):
		code, description = "EISDIR", "illegal operation on a directory"
	case errors.Is(err, syscall.ENOTDIR):
		code, description = "ENOTDIR", "not a directory"
	case errors.Is(err, syscall.ELOOP):
		code, description = "ELOOP", "too many symbolic links encountered"
	case errors.Is(err, syscall.ENOSPC):
		code, description = "ENOSPC", "no space left on device"
	default:
		return err
	}
	return fmt.Errorf("%s: %s, %s '%s'", code, description, operation, path)
}

func (w *fileTools) writeDefinition() sdk.ToolDefinition {
	c := w.capture
	return sdk.ToolDefinition{
		Name: "write", Label: "write", Description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		ConstrainedSampling: sdk.ConstrainedSampling{Type: "json_schema", Strict: "prefer"},
		PromptSnippet:       "Create or overwrite files", PromptGuidelines: []string{"Use write only for new files or complete rewrites."}, DefaultActive: sdk.Bool(false),
		Parameters: sdk.Schema{"type": "object", "required": []string{"path", "content"}, "properties": map[string]any{"path": map[string]any{"type": "string", "description": "Path to the file to write (relative or absolute)"}, "content": map[string]any{"type": "string", "description": "Content to write to the file"}}},
		Execute: func(ctx sdk.Context, input map[string]any) (any, error) {
			path, content := str(input, "path"), str(input, "content")
			prepared, err := w.execution(ctx, input)
			if err != nil {
				return nil, err
			}
			defer w.finish(ctx.ToolCallID())
			absolute := prepared.path
			err = prepared.ticket.run(ctx.Done(), ctx.Err, func() error {
				if err := os.MkdirAll(filepath.Dir(absolute), 0755); err != nil {
					return fsError(err, "mkdir", filepath.Dir(absolute))
				}
				if ctx.Err() != nil {
					return errors.New("Operation aborted")
				}
				nested := c.nested(ctx.ToolCallID())
				var before beforeWrite
				if nested {
					before = snapshot(absolute, !textFits(content, maxTextBytes, maxTextLines))
				}
				if ctx.Err() != nil {
					return errors.New("Operation aborted")
				}
				if err := os.WriteFile(absolute, []byte(content), 0644); err != nil {
					return fsError(err, "open", absolute)
				}
				if nested {
					c.add(writeChange(ctx.ToolCallID(), path, before, content))
				}
				if ctx.Err() != nil {
					return errors.New("Operation aborted")
				}
				return nil
			})
			if err != nil {
				return nil, err
			}
			return sdk.ToolResult{Content: "Successfully wrote to " + path}, nil
		},
	}
}
