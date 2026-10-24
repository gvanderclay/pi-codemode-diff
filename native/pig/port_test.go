package pig

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	"github.com/rivo/uniseg"
)

func TestTypeScriptOracle(t *testing.T) {
	data, err := os.ReadFile("testdata/typescript.json")
	if err != nil {
		t.Fatal(err)
	}
	var oracle struct {
		Diffs  []struct{ Old, New, Expected string }
		Writes []struct {
			Before struct {
				Kind, Content, Reason string
				SizeBytes             int64
			}
			Content, Repeat string
			Count           int
			Expected        change
		}
		Words     []struct{ Input, Expected string }
		Persisted []struct {
			Data     map[string]any
			Expected []change
		}
	}
	if err := json.Unmarshal(data, &oracle); err != nil {
		t.Fatal(err)
	}
	t.Run("line_diffs", func(t *testing.T) {
		for i, item := range oracle.Diffs {
			got, _ := generateDiffString(item.Old, item.New, 4)
			if got != item.Expected {
				t.Errorf("case %d: got %q want %q", i, got, item.Expected)
			}
		}
	})
	t.Run("write_metadata", func(t *testing.T) {
		for i, item := range oracle.Writes {
			content := item.Content
			if item.Repeat != "" {
				content = strings.Repeat(item.Repeat, item.Count)
			}
			got := writeChange("root/1", "file.txt", beforeWrite{kind: item.Before.Kind, content: item.Before.Content, reason: item.Before.Reason, size: item.Before.SizeBytes}, content)
			if !reflect.DeepEqual(got, item.Expected) {
				t.Errorf("case %d: got %+v want %+v", i, got, item.Expected)
			}
		}
	})
	t.Run("word_highlighting", func(t *testing.T) {
		for i, item := range oracle.Words {
			if got := coloredDiff(item.Input, sdk.UITheme{}); got != item.Expected {
				t.Errorf("case %d: got %q want %q", i, got, item.Expected)
			}
		}
	})
	t.Run("persisted_validation", func(t *testing.T) {
		for i, item := range oracle.Persisted {
			if got := readChanges(item.Data); !reflect.DeepEqual(got, item.Expected) {
				t.Errorf("case %d: got %+v want %+v", i, got, item.Expected)
			}
		}
	})
}

func TestCaptureIsolationOrderingBudgetsAndLifetime(t *testing.T) {
	c := newCapture()
	c.start("direct", "write", "")
	if c.nested("direct") {
		t.Fatal("direct call captured")
	}
	c.start("a", "codemode", "")
	c.start("b", "codemode_o", "")
	c.start("a/1", "helper", "a")
	c.start("a/1/1", "write", "a/1")
	c.start("a/2", "edit", "a")
	c.start("b/1", "edit", "b")
	c.add(change{ToolCallID: "a/2", Tool: "edit", Path: "second", Kind: "edit", Diff: new("+1 later")})
	c.add(change{ToolCallID: "a/1/1", Tool: "write", Path: "first", Kind: "create", Diff: new("+1 before")})
	c.add(change{ToolCallID: "b/1", Tool: "edit", Path: "other", Kind: "edit", Diff: new("+1 other")})
	c.reportError("a/1/1")
	a := c.details("a")
	if len(a.Changes) != 2 || a.Changes[0].Path != "first" || !a.Changes[0].ToolReportedError {
		t.Fatalf("bad order or status: %+v", a)
	}
	c.end("a/1/1")
	if len(c.details("a").Changes) != 2 {
		t.Fatal("child completion cleared root")
	}
	c.end("a")
	if c.details("a") != nil || c.nested("a/2") || c.details("b") == nil {
		t.Fatal("root cleanup leaked or crossed batches")
	}
	if a.Changes[0].Path != "first" {
		t.Fatal("saved details mutated")
	}
	c.clear()
	if c.details("b") != nil {
		t.Fatal("lifecycle cleanup failed")
	}
	c.start("limit", "codemode", "")
	for i, id := range []string{"1", "2", "3", "4", "5"} {
		c.start(id, "write", "limit")
		c.add(change{ToolCallID: id, Diff: new(strings.Repeat("x", maxDiffBytes))})
		if i == 4 && c.details("limit").Changes[4].Diff != nil {
			t.Fatal("batch byte budget not enforced")
		}
	}
	c.add(change{ToolCallID: "1", Diff: new("+1 reduced")})
	c.add(change{ToolCallID: "5", Diff: new("+1 small")})
	if c.details("limit").Changes[4].Diff == nil {
		t.Fatal("small later replacement should fit")
	}
}

func TestCaptureConcurrentParents(t *testing.T) {
	c := newCapture()
	var wg sync.WaitGroup
	for i, id := range []string{"a", "b", "c", "d"} {
		wg.Go(func() {
			name := "codemode"
			if i%2 == 1 {
				name = "codemode_o"
			}
			c.start(id, name, "")
			for i := range 100 {
				child := id + strings.Repeat("x", i+1)
				c.start(child, "write", id)
				c.add(change{ToolCallID: child, Diff: new("+1 text")})
				c.reportError(child)
			}
			if got := c.details(id); got == nil || len(got.Changes) != 100 {
				t.Errorf("lost %s changes", id)
			}
			c.end(id)
		})
	}
	wg.Wait()
}

func TestSnapshotAndWriteLimits(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	if got := snapshot(path, false); got.kind != "missing" {
		t.Fatal(got)
	}
	for _, item := range []struct{ name, content, kind string }{{"text", "hello\n", "text"}, {"binary", "a\x00b", "unavailable"}, {"invalid", "\xff", "unavailable"}, {"bytes", strings.Repeat("x", maxTextBytes+1), "omitted"}, {"lines", strings.Repeat("x\n", maxTextLines+1), "omitted"}} {
		t.Run(item.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(item.content), 0600); err != nil {
				t.Fatal(err)
			}
			got := snapshot(path, false)
			if got.kind != item.kind {
				t.Fatalf("%+v", got)
			}
		})
	}
	if got := snapshot(dir, false); got.kind != "unavailable" {
		t.Fatal(got)
	}
	if err := os.WriteFile(path, []byte("read skipped"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := snapshot(path, true); got.kind != "omitted" || got.content != "" {
		t.Fatal(got)
	}
	for _, s := range []string{"", "a", "a\n", "a\r\n", "a\r", "a\nb"} {
		want := 1
		if s == "" {
			want = 0
		}
		if s == "a\nb" {
			want = 2
		}
		if got := lineCount(s); got != want {
			t.Fatalf("lineCount(%q)=%d want %d", s, got, want)
		}
	}
	if !textFits(strings.Repeat("x", maxTextBytes), maxTextBytes, maxTextLines) || textFits(strings.Repeat("한", maxTextBytes/3+1), maxTextBytes, maxTextLines) {
		t.Fatal("UTF-8 byte boundary failed")
	}
}

func TestMutationQueueOrdersAliasesAndDrainsCancellation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "alias")
	if err := os.Symlink(path, alias); err != nil {
		t.Skip(err)
	}
	q := &mutationQueue{}
	first, err := q.reserve(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := q.reserve(alias)
	if err != nil {
		t.Fatal(err)
	}
	third, err := q.reserve(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	var output []int
	var wg sync.WaitGroup
	wg.Go(func() {
		if err := third.run(nil, func() error { return nil }, func() error { output = append(output, 3); return nil }); err != nil {
			t.Error(err)
		}
	})
	wg.Go(func() {
		if err := second.run(ctx.Done(), ctx.Err, func() error { t.Error("cancelled callback ran"); return nil }); err == nil {
			t.Error("cancellation lost")
		}
	})
	if err := first.run(nil, func() error { return nil }, func() error { output = append(output, 1); return nil }); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if !reflect.DeepEqual(output, []int{1, 3}) || len(q.paths) != 0 {
		t.Fatalf("order=%v retained=%d", output, len(q.paths))
	}
}

func TestPreparedWritesReleaseBlockedCallsWithoutOvertaking(t *testing.T) {
	w := newFileTools(newCapture())
	dir := t.TempDir()
	for _, id := range []string{"first", "blocked", "last"} {
		w.prepare(id, dir, map[string]any{"path": "same.txt"})
	}
	first, last := w.pending["first"].ticket, w.pending["last"].ticket
	w.finish("blocked")
	select {
	case <-last.ready:
		t.Fatal("blocked call released a later writer past the first")
	default:
	}
	select {
	case <-first.ready:
	default:
		t.Fatal("first writer not admitted")
	}
	w.finish("first")
	select {
	case <-last.ready:
	default:
		t.Fatal("queue did not advance past skipped call")
	}
	w.clear()
	if len(w.pending) != 0 || len(w.queue.paths) != 0 {
		t.Fatal("lifecycle cleanup retained queue state")
	}
}

var sgr = regexp.MustCompile("\x1b\\[[0-9;]*m")

func TestRendererExpansionSanitizationAndNarrowWidths(t *testing.T) {
	diff := strings.Repeat("+1 한글 🐷 long text\n", 30)
	items := []change{{Tool: "write", Kind: "create", Path: "evil\n\x1b[2J", Diff: &diff, ToolReportedError: true}, {Tool: "edit", Kind: "edit", Path: "b"}, {Tool: "write", Kind: "create", Path: "c"}, {Tool: "write", Kind: "create", Path: "fourth"}}
	for _, width := range []int{1, 2, 8, 16, 80} {
		for _, expanded := range []bool{false, true} {
			lines := renderChanges("codemode", "root", items, expanded, width, sdk.UITheme{})
			for _, line := range lines {
				plain := sgr.ReplaceAllString(line, "")
				if uniseg.StringWidth(plain) > width || strings.ContainsRune(plain, '\x1b') {
					t.Fatalf("unsafe line at width %d: %q", width, line)
				}
			}
		}
	}
	collapsed := sgr.ReplaceAllString(strings.Join(renderChanges("codemode", "root", items, false, 80, sdk.UITheme{}), "\n"), "")
	full := sgr.ReplaceAllString(strings.Join(renderChanges("codemode", "root", items, true, 80, sdk.UITheme{}), "\n"), "")
	if !strings.Contains(collapsed, "more lines") || strings.Contains(collapsed, "fourth") || !strings.Contains(full, "fourth") || !strings.Contains(full, "error or cancellation") || !strings.Contains(full, `evil\n`) {
		t.Fatal("bad preview or expansion")
	}
}

func BenchmarkBoundedWriteDiff(b *testing.B) {
	old := strings.Repeat("const timeout = 1000;\n", 500)
	next := strings.Replace(old, "1000", "5000", 1)
	b.ReportAllocs()
	for b.Loop() {
		writeChange("root/1", "file", beforeWrite{kind: "text", content: old}, next)
	}
}
func BenchmarkCollapsedRender(b *testing.B) {
	item := change{Tool: "write", Kind: "create", Path: "large", Diff: new(strings.Repeat("+1 line\n", 2000))}
	b.ReportAllocs()
	for b.Loop() {
		renderChanges("codemode", "root", []change{item}, false, 80, sdk.UITheme{})
	}
}
