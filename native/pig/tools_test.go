package pig

import (
	"encoding/json"
	"strings"
	"testing"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func TestSupportedRootsAndLegacyEntryNames(t *testing.T) {
	for _, name := range []string{"codemode", "codemode_o", "codemode_other", "codemode_o_extra", "helper", ""} {
		t.Run(name, func(t *testing.T) {
			want := name == "codemode" || name == "codemode_o"
			if isCodemodeTool(name) != want {
				t.Fatal("root predicate accepted a prefix or rejected a supported tool")
			}
			c := newCapture()
			c.start("root", name, "")
			c.start("root/1", "helper", "root")
			c.start("root/1/1", "write", "root/1")
			c.add(change{ToolCallID: "root/1/1", Tool: "write", Path: "file", Kind: "create", Diff: new("+1 kept")})
			if (c.details("root") != nil) != want || c.nested("root/1/1") != want {
				t.Fatal("incorrect ancestry")
			}
			c.clear()
			if c.details("root") != nil || c.nested("root/1/1") {
				t.Fatal("lifecycle cleanup retained descendants")
			}
		})
	}
	for _, value := range []any{nil, 42, "codemode", "codemode_o", "codemode_o_extra", "\x1b[2J"} {
		data := map[string]any{"toolName": value}
		want := "codemode"
		if value == "codemode_o" {
			want = "codemode_o"
		}
		if got := entryToolName(data); got != want {
			t.Fatalf("entry tool %v: %q", value, got)
		}
	}
}

func TestBothRootsShareDiffBudgetsAndSavedRendering(t *testing.T) {
	for _, name := range []string{"codemode", "codemode_o"} {
		t.Run(name, func(t *testing.T) {
			c := newCapture()
			c.start("root", name, "")
			for _, id := range []string{"1", "2", "3", "4", "5"} {
				c.start(id, "write", "root")
				c.add(change{ToolCallID: id, Tool: "write", Path: "same.txt", Kind: "overwrite", Diff: new(strings.Repeat("x", maxDiffBytes))})
			}
			saved := c.details("root")
			if saved.Changes[4].Diff != nil || saved.Changes[4].Note == "" {
				t.Fatal("parent budget not applied")
			}
			c.reportError("1")
			// Simulate the JSON boundary used by source/fused saved entries.
			bytes, err := json.Marshal(map[string]any{"toolCallId": "root", "toolName": name, detailsKey: c.details("root")})
			if err != nil {
				t.Fatal(err)
			}
			c.end("root")
			var data map[string]any
			if err := json.Unmarshal(bytes, &data); err != nil {
				t.Fatal(err)
			}
			for _, expanded := range []bool{false, true} {
				output := sgr.ReplaceAllString(strings.Join(renderChanges(entryToolName(data), "root", readChanges(data), expanded, 80, sdk.UITheme{}), "\n"), "")
				if !strings.HasPrefix(output, name+" root\n") || !strings.Contains(output, "error or cancellation") || !strings.Contains(output, "1 diff unavailable") {
					t.Fatal("saved header, omission or final error lost")
				}
			}
		})
	}
}
