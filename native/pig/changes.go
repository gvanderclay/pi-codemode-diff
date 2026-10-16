package pig

import (
	"fmt"
	"math"
	"strings"
)

const (
	detailsKey    = "piCodemodeDiff"
	entryType     = "pi-codemode-diff:pig"
	maxTextBytes  = 256 * 1024
	maxTextLines  = 2000
	maxDiffBytes  = 64 * 1024
	maxDiffLines  = 2000
	maxBatchBytes = 256 * 1024
	maxBatchLines = 8000
)

type change struct {
	ToolCallID        string  `json:"toolCallId"`
	Tool              string  `json:"tool"`
	Path              string  `json:"path"`
	Kind              string  `json:"kind"`
	Diff              *string `json:"diff,omitempty"`
	Note              string  `json:"note,omitempty"`
	BeforeBytes       *int64  `json:"beforeBytes,omitempty"`
	AfterBytes        *int64  `json:"afterBytes,omitempty"`
	ToolReportedError bool    `json:"toolReportedError,omitempty"`
}

type diffDetails struct {
	Version int      `json:"version"`
	Changes []change `json:"changes"`
}

func lineCount(text string) int {
	if text == "" {
		return 0
	}
	n := 1
	for i := 0; i < len(text); i++ {
		if text[i] != '\r' && text[i] != '\n' {
			continue
		}
		if text[i] == '\r' && i+1 < len(text) && text[i+1] == '\n' {
			i++
		}
		if i+1 < len(text) {
			n++
		}
	}
	return n
}

func textFits(text string, bytes, lines int) bool {
	return len(text) <= bytes && lineCount(text) <= lines
}

func limitChange(c change, bytes, lines int) change {
	if c.Diff == nil {
		return c
	}
	reason := ""
	if !textFits(*c.Diff, maxDiffBytes, maxDiffLines) {
		reason = "diff too large"
	} else if !textFits(*c.Diff, bytes, lines) {
		reason = "codemode diff budget exceeded"
	}
	if reason != "" {
		c.Diff = nil
		c.Note = "Diff omitted: " + reason + "." + suffix(c.Note)
	}
	return c
}

func suffix(s string) string {
	if s == "" {
		return ""
	}
	return " " + s
}
func record(v any) map[string]any             { m, _ := v.(map[string]any); return m }
func str(m map[string]any, key string) string { s, _ := m[key].(string); return s }
func flag(m map[string]any, key string) bool  { b, _ := m[key].(bool); return b }

// Validate persisted data before rendering; old entries receive current budgets.
func readChanges(data any) []change {
	payload := record(record(data)[detailsKey])
	version, ok := safeSize(payload["version"])
	if !ok || version != 1 {
		return nil
	}
	raw, ok := payload["changes"].([]any)
	if !ok {
		return nil
	}
	changes := make([]change, 0, len(raw))
	bytes, lines := maxBatchBytes, maxBatchLines
	for _, value := range raw {
		fields := record(value)
		if fields == nil {
			return nil
		}
		for _, key := range []string{"toolCallId", "tool", "path", "kind"} {
			if _, ok := fields[key].(string); !ok {
				return nil
			}
		}
		c := change{ToolCallID: str(fields, "toolCallId"), Tool: str(fields, "tool"), Path: str(fields, "path"), Kind: str(fields, "kind")}
		if (c.Tool != "write" && c.Tool != "edit") || (c.Kind != "edit" && c.Kind != "create" && c.Kind != "overwrite" && c.Kind != "unknown") {
			return nil
		}
		if v, exists := fields["diff"]; exists {
			diff, ok := v.(string)
			if !ok {
				return nil
			}
			c.Diff = &diff
		}
		if v, exists := fields["note"]; exists {
			note, ok := v.(string)
			if !ok {
				return nil
			}
			c.Note = note
		}
		if v, exists := fields["toolReportedError"]; exists {
			failed, ok := v.(bool)
			if !ok {
				return nil
			}
			c.ToolReportedError = failed
		}
		for _, field := range []struct {
			name   string
			target **int64
		}{{"beforeBytes", &c.BeforeBytes}, {"afterBytes", &c.AfterBytes}} {
			if v, exists := fields[field.name]; exists {
				size, ok := safeSize(v)
				if !ok {
					return nil
				}
				*field.target = new(size)
			}
		}
		c = limitChange(c, bytes, lines)
		if c.Diff != nil {
			bytes -= len(*c.Diff)
			lines -= lineCount(*c.Diff)
		}
		changes = append(changes, c)
	}
	return changes
}

func safeSize(value any) (int64, bool) {
	var number float64
	switch v := value.(type) {
	case float64:
		number = v
	case int:
		number = float64(v)
	case int64:
		number = float64(v)
	default:
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > 9007199254740991 || math.Trunc(number) != number {
		return 0, false
	}
	return int64(number), true
}

type beforeWrite struct {
	kind, content, reason string
	size                  int64
}

func displayText(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(strings.TrimPrefix(s, "\ufeff"), "\r\n", "\n"), "\r", "\n")
}

func writeChange(id, path string, before beforeWrite, content string) change {
	c := change{ToolCallID: id, Tool: "write", Path: path, Kind: "unknown"}
	switch before.kind {
	case "missing":
		c.Kind = "create"
	case "text", "omitted":
		c.Kind = "overwrite"
	}
	if before.kind == "unavailable" {
		c.Note = before.reason
		return c
	}
	if before.kind == "omitted" || !textFits(content, maxTextBytes, maxTextLines) || (before.kind == "text" && !textFits(before.content, maxTextBytes, maxTextLines)) {
		size := int64(len(before.content))
		if before.kind == "omitted" {
			size = before.size
		}
		c.BeforeBytes, c.AfterBytes = new(size), new(int64(len(content)))
		c.Note = fmt.Sprintf("Diff omitted: file too large (byte or line limit; before: %d bytes; after: %d bytes).", size, len(content))
		return c
	}
	if strings.ContainsRune(content, 0) {
		c.Note = "Binary content; text diff unavailable."
		return c
	}
	oldText, newText := displayText(before.content), displayText(content)
	diff, _ := generateDiffString(oldText, newText, 4)
	c.Diff = &diff
	switch {
	case before.kind == "missing" && content == "":
		c.Note = "Created an empty file."
	case before.content == content:
		c.Note = "No content changes."
	case oldText == newText:
		c.Note = "Only line endings or the UTF-8 BOM changed (normalized in this view)."
	}
	c = limitChange(c, maxBatchBytes, maxBatchLines)
	if c.Diff == nil {
		c.BeforeBytes, c.AfterBytes = new(int64(len(before.content))), new(int64(len(content)))
	}
	return c
}
