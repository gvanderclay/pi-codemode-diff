package pig

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"strings"
	"syscall"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

type editEntry struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

func singleEdit(value any) bool {
	input := record(value)
	_, old := input["oldText"].(string)
	_, next := input["newText"].(string)
	return old && next
}

// Preserve the SDK's legacy, single-object and JSON-string input adapters.
func prepareEditArguments(input map[string]any) (map[string]any, error) {
	input = maps.Clone(input)
	if encoded, ok := input["edits"].(string); ok {
		var parsed any
		if json.Unmarshal([]byte(encoded), &parsed) == nil {
			if list, ok := parsed.([]any); ok {
				input["edits"] = list
			} else if singleEdit(parsed) {
				input["edits"] = []any{parsed}
			}
		}
	} else if singleEdit(input["edits"]) {
		input["edits"] = []any{input["edits"]}
	}
	if singleEdit(input) {
		list, _ := input["edits"].([]any)
		input["edits"] = append(append([]any{}, list...), map[string]any{"oldText": input["oldText"], "newText": input["newText"]})
		delete(input, "oldText")
		delete(input, "newText")
	}
	return input, nil
}

func editEntries(input map[string]any) ([]editEntry, error) {
	raw, ok := input["edits"].([]any)
	if !ok || len(raw) == 0 {
		return nil, errors.New("Edit tool input is invalid. edits must contain at least one replacement.")
	}
	entries := make([]editEntry, len(raw))
	for i, value := range raw {
		fields := record(value)
		old, oldOK := fields["oldText"].(string)
		next, nextOK := fields["newText"].(string)
		if !oldOK || !nextOK {
			return nil, errors.New("Edit tool input is invalid. edits must contain string oldText and newText fields.")
		}
		entries[i] = editEntry{old, next}
	}
	return entries, nil
}

func editSchema() sdk.Schema {
	return sdk.Schema{"type": "object", "required": []string{"path", "edits"}, "properties": map[string]any{
		"path": map[string]any{"type": "string", "description": "Path to the file to edit (relative or absolute)"},
		"edits": map[string]any{"type": "array", "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.", "items": map[string]any{"type": "object", "required": []string{"oldText", "newText"}, "properties": map[string]any{
			"oldText": map[string]any{"type": "string", "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."},
			"newText": map[string]any{"type": "string", "description": "Replacement text for this targeted edit."},
		}}},
	}}
}

func (w *fileTools) editDefinition() sdk.ToolDefinition {
	return sdk.ToolDefinition{
		Name: "edit", Label: "edit", Description: "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		PromptSnippet:    "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		PromptGuidelines: []string{"Use edit for precise changes (edits[].oldText must match exactly)", "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls", "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.", "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions."},
		Parameters:       editSchema(), ConstrainedSampling: sdk.ConstrainedSampling{Type: "json_schema", Strict: "prefer"}, DefaultActive: sdk.Bool(false), PrepareArguments: prepareEditArguments,
		Execute: func(ctx sdk.Context, input map[string]any) (any, error) {
			entries, err := editEntries(input)
			if err != nil {
				return nil, err
			}
			prepared, err := w.execution(ctx, input)
			if err != nil {
				return nil, err
			}
			defer w.finish(ctx.ToolCallID())
			var result sdk.ToolResult
			err = prepared.ticket.run(ctx.Done(), ctx.Err, func() error {
				var err error
				result, err = editLocked(ctx.Err, prepared.path, str(input, "path"), entries)
				return err
			})
			if err != nil {
				return nil, err
			}
			return result, nil
		},
	}
}

// The caller holds the shared write/edit reservation for the entire operation.
func editLocked(cancelled func() error, absolute, path string, entries []editEntry) (sdk.ToolResult, error) {
	aborted := func() error {
		if cancelled() != nil {
			return errors.New("Operation aborted")
		}
		return nil
	}
	if err := aborted(); err != nil {
		return sdk.ToolResult{}, err
	}
	if err := accessReadWrite(absolute); err != nil {
		if abort := aborted(); abort != nil {
			return sdk.ToolResult{}, abort
		}
		code := ""
		switch {
		case errors.Is(err, os.ErrNotExist):
			code = "ENOENT"
		case errors.Is(err, syscall.EPERM):
			code = "EPERM"
		case errors.Is(err, os.ErrPermission):
			code = "EACCES"
		case errors.Is(err, syscall.ENOTDIR):
			code = "ENOTDIR"
		case errors.Is(err, syscall.ELOOP):
			code = "ELOOP"
		}
		detail := "Error: " + err.Error()
		if code != "" {
			detail = "Error code: " + code
		}
		return sdk.ToolResult{}, fmt.Errorf("Could not edit file: %s. %s.", path, detail)
	}
	if err := aborted(); err != nil {
		return sdk.ToolResult{}, err
	}
	data, err := os.ReadFile(absolute)
	if err != nil {
		return sdk.ToolResult{}, fsError(err, "read", "")
	}
	if err := aborted(); err != nil {
		return sdk.ToolResult{}, err
	}
	var decoder utf8StreamDecoder
	raw := decoder.decode(data, false)
	bom := ""
	if strings.HasPrefix(raw, "\ufeff") {
		bom = "\ufeff"
		raw = strings.TrimPrefix(raw, bom)
	}
	ending := detectLineEnding(raw)
	applied, err := applyEditsToNormalizedContent(normalizeToLF(raw), entries, path)
	if err != nil {
		return sdk.ToolResult{}, err
	}
	if err := aborted(); err != nil {
		return sdk.ToolResult{}, err
	}
	if err := os.WriteFile(absolute, []byte(bom+restoreLineEndings(applied.newContent, ending)), 0644); err != nil {
		return sdk.ToolResult{}, fsError(err, "open", absolute)
	}
	if err := aborted(); err != nil {
		return sdk.ToolResult{}, err
	}
	diff, first := generateDiffString(applied.baseContent, applied.newContent, 4)
	return sdk.ToolResult{Content: fmt.Sprintf("Successfully replaced %d block(s) in %s.", len(entries), path), Details: map[string]any{"diff": diff, "patch": generateUnifiedPatch(path, applied.baseContent, applied.newContent), "firstChangedLine": first}}, nil
}
