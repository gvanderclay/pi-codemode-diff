package pig

import (
	"encoding/json"
	"strings"
	"testing"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func TestRendererSummary(t *testing.T) {
	cases := []struct {
		name  string
		items []change
		want  string
	}{
		{"single", []change{{Path: "a", Diff: new("")}}, "File changes (1) · 1 file"},
		{"repeated", []change{{Path: "a", Diff: new("+1 first")}, {Path: "a", Diff: new("+1 second")}}, "File changes (2) · 1 file"},
		{"recorded_paths", []change{{Path: "a", Diff: new("")}, {Path: "./a", Diff: new("")}, {Path: "/tmp/a", Diff: new("")}, {Path: "A", Diff: new("")}, {Path: "한글", Diff: new("")}}, "File changes (5) · 5 files"},
		{"unavailable_beyond_preview", []change{{Path: "a", Diff: new("+1 a")}, {Path: "b", Diff: new("+1 b")}, {Path: "c", Diff: new("")}, {Path: "a", Note: "Binary content; text diff unavailable."}, {Path: "a"}}, "File changes (5) · 3 files · 2 diffs unavailable"},
		{"omitted", []change{limitChange(change{Path: "a", Diff: new(strings.Repeat("x", maxDiffBytes+1))}, maxBatchBytes, maxBatchLines)}, "File changes (1) · 1 file · 1 diff unavailable"},
		{"empty_diffs", []change{{Path: "a", Diff: new(""), Note: "Created an empty file."}, {Path: "b", Diff: new(""), Note: "No content changes."}, {Path: "c", Diff: new(""), Note: "Only line endings or the UTF-8 BOM changed (normalized in this view)."}}, "File changes (3) · 3 files"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before, _ := json.Marshal(tc.items)
			for _, expanded := range []bool{false, true} {
				output := sgr.ReplaceAllString(strings.Join(renderChanges("codemode", "root", tc.items, expanded, 120, sdk.UITheme{}), "\n"), "")
				if !strings.Contains(output, "\n"+tc.want+"\n") {
					t.Fatalf("expanded=%v: expected header %q in %q", expanded, tc.want, output)
				}
				if tc.name == "repeated" && (!strings.Contains(output, "+1 first") || !strings.Contains(output, "+1 second")) {
					t.Fatal("repeated-path changes were merged")
				}
				if tc.name == "unavailable_beyond_preview" && strings.Contains(output, "Binary content") != expanded {
					t.Fatal("per-change notice must follow preview/expansion independently of summary")
				}
			}
			after, _ := json.Marshal(tc.items)
			if string(before) != string(after) {
				t.Fatal("summary modified display metadata")
			}
		})
	}
	if lines := renderChanges("codemode", "root", nil, false, 80, sdk.UITheme{}); len(lines) != 0 {
		t.Fatal("empty batch should not render a summary")
	}
}

func TestRendererSummaryFromLegacyEntry(t *testing.T) {
	data := map[string]any{detailsKey: map[string]any{"version": 1, "changes": []any{
		map[string]any{"toolCallId": "root/1", "tool": "write", "path": "a", "kind": "create", "diff": ""},
		map[string]any{"toolCallId": "root/2", "tool": "edit", "path": "a", "kind": "edit", "diff": strings.Repeat("x", maxDiffBytes+1)},
	}}}
	before, _ := json.Marshal(data)
	for _, expanded := range []bool{false, true} {
		output := sgr.ReplaceAllString(strings.Join(renderChanges("codemode", "root", readChanges(data), expanded, 120, sdk.UITheme{}), "\n"), "")
		if !strings.Contains(output, "File changes (2) · 1 file · 1 diff unavailable") || !strings.Contains(output, "Diff omitted: diff too large") {
			t.Fatal("legacy entry summary must use currently bounded diffs")
		}
	}
	after, _ := json.Marshal(data)
	if string(before) != string(after) {
		t.Fatal("rendering rewrote saved metadata")
	}
}
