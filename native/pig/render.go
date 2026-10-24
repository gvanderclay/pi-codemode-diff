package pig

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
	"github.com/rivo/uniseg"
)

func safeText(s string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 0 && r <= 8) || (r >= 11 && r <= 31) || (r >= 127 && r <= 159) {
			return '\ufffd'
		}
		return r
	}, strings.ReplaceAll(s, "\t", "   "))
}
func inlineText(s string) string { return strings.ReplaceAll(safeText(s), "\n", `\n`) }

var diffLine = regexp.MustCompile(`^([+\-\s])(\s*\d*)\s(.*)$`)
var changedLine = regexp.MustCompile(`^[+\-]\s*\d+ `)

func changeCounts(diff *string) (added, removed int) {
	if diff == nil {
		return
	}
	for line := range strings.SplitSeq(*diff, "\n") {
		if changedLine.MatchString(line) {
			if line[0] == '+' {
				added++
			} else {
				removed++
			}
		}
	}
	return
}

// jsdiff whitespace normalization can change a shared part. Preserve both
// original lines by falling back whenever reconstruction differs.
func highlightWords(old, new string, theme sdk.UITheme) (string, string) {
	if len(utf16.Encode([]rune(old)))+len(utf16.Encode([]rune(new))) > 40000 {
		return old, new
	}
	a, b := wordTokens(old), wordTokens(new)
	parts := diffWords(a, b, 1000)
	if parts == nil {
		return old, new
	}
	var oldCheck, newCheck strings.Builder
	for _, part := range parts {
		if !part.added {
			oldCheck.WriteString(part.value)
		}
		if !part.removed {
			newCheck.WriteString(part.value)
		}
	}
	if oldCheck.String() != old || newCheck.String() != new {
		return old, new
	}
	var left, right strings.Builder
	firstOld, firstNew := true, true
	for _, part := range parts {
		if !part.added && !part.removed {
			left.WriteString(part.value)
			right.WriteString(part.value)
			continue
		}
		value := part.value
		first, output := &firstNew, &right
		if part.removed {
			first, output = &firstOld, &left
		}
		if *first {
			trimmed := strings.TrimLeftFunc(value, jsSpace)
			output.WriteString(value[:len(value)-len(trimmed)])
			value = trimmed
			*first = false
		}
		if value != "" {
			output.WriteString(theme.Inverse(value))
		}
	}
	return left.String(), right.String()
}

func coloredDiff(diff string, theme sdk.UITheme) string {
	lines := strings.Split(diff, "\n")
	color := func(line string) string {
		token := "toolDiffContext"
		if strings.HasPrefix(line, "+") {
			token = "toolDiffAdded"
		} else if strings.HasPrefix(line, "-") {
			token = "toolDiffRemoved"
		}
		return theme.Fg(token, line)
	}
	var output []string
	for i := 0; i < len(lines); {
		parsed := diffLine.FindStringSubmatch(lines[i])
		if parsed == nil || parsed[1] != "-" {
			output = append(output, color(lines[i]))
			i++
			continue
		}
		start := i
		for i < len(lines) {
			match := diffLine.FindStringSubmatch(lines[i])
			if match == nil || match[1] != "-" {
				break
			}
			i++
		}
		addedStart := i
		for i < len(lines) {
			match := diffLine.FindStringSubmatch(lines[i])
			if match == nil || match[1] != "+" {
				break
			}
			i++
		}
		if addedStart-start == 1 && i-addedStart == 1 {
			old, new := diffLine.FindStringSubmatch(lines[start]), diffLine.FindStringSubmatch(lines[addedStart])
			a, b := highlightWords(old[3], new[3], theme)
			output = append(output, color("-"+old[2]+" "+a), color("+"+new[2]+" "+b))
		} else {
			for _, line := range lines[start:i] {
				output = append(output, color(line))
			}
		}
	}
	return strings.Join(output, "\n")
}

// Wrap sanitized text by grapheme width. Only theme-generated SGR escapes reach
// this function. Reset at line ends and reapply styles after a visual wrap.
func wrapText(text string, width int) []string {
	if width < 1 {
		return nil
	}
	var result []string
	for logical := range strings.SplitSeq(text, "\n") {
		var line strings.Builder
		cells := 0
		styles := ""
		for len(logical) > 0 {
			if strings.HasPrefix(logical, "\x1b[") {
				end := strings.IndexByte(logical, 'm')
				if end >= 0 {
					escape := logical[:end+1]
					line.WriteString(escape)
					if escape == "\x1b[0m" {
						styles = ""
					} else {
						styles += escape
					}
					logical = logical[end+1:]
					continue
				}
			}
			cluster, rest, _, _ := uniseg.FirstGraphemeClusterInString(logical, -1)
			w := uniseg.StringWidth(cluster)
			if w > width {
				cluster = "\ufffd"
				w = 1
			}
			if cells+w > width {
				result = append(result, line.String()+"\x1b[0m")
				line.Reset()
				line.WriteString(styles)
				cells = 0
			}
			line.WriteString(cluster)
			cells += w
			logical = rest
		}
		result = append(result, line.String()+"\x1b[0m")
	}
	return result
}

func renderChanges(toolName, id string, changes []change, expanded bool, width int, theme sdk.UITheme) []string {
	if len(changes) == 0 || width < 1 {
		return nil
	}
	var lines []string
	add := func(text string) { lines = append(lines, wrapText(text, width)...) }
	add(theme.Fg("muted", inlineText(toolName)+" "+inlineText(id)))
	add("")
	// Summarize the whole batch, not only the collapsed preview. Compare paths
	// exactly as recorded; counting must not perform filesystem reads.
	files := make(map[string]struct{})
	unavailable := 0
	for _, item := range changes {
		files[item.Path] = struct{}{}
		// A non-nil empty diff is available (e.g. an unchanged write).
		if item.Diff == nil {
			unavailable++
		}
	}
	fileLabel := "files"
	if len(files) == 1 {
		fileLabel = "file"
	}
	summary := fmt.Sprintf("File changes (%d) · %d %s", len(changes), len(files), fileLabel)
	if unavailable > 0 {
		diffLabel := "diffs"
		if unavailable == 1 {
			diffLabel = "diff"
		}
		summary += fmt.Sprintf(" · %d %s unavailable", unavailable, diffLabel)
	}
	add(theme.Fg("toolTitle", theme.Bold(summary)))
	shown := len(changes)
	if !expanded {
		shown = min(shown, 3)
	}
	for _, item := range changes[:shown] {
		add("")
		label := item.Tool
		switch item.Kind {
		case "create":
			label = "write · new"
		case "overwrite":
			label = "write · overwrite"
		}
		counts := ""
		if item.Diff != nil {
			plus, minus := changeCounts(item.Diff)
			counts = " " + theme.Fg("toolDiffAdded", fmt.Sprintf("+%d", plus)) + " " + theme.Fg("toolDiffRemoved", fmt.Sprintf("-%d", minus))
		}
		add(theme.Fg("toolTitle", inlineText(item.Path)) + " " + theme.Fg("muted", "["+label+"]") + counts)
		if item.Diff != nil && *item.Diff != "" {
			visual := wrapText(coloredDiff(safeText(*item.Diff), theme), width)
			if !expanded && len(visual) > 8 {
				skipped := len(visual) - 8
				visual = visual[:8]
				visual = append(visual, truncateText(theme.Fg("muted", fmt.Sprintf("… (%d more lines, expand tool output)", skipped)), width))
			}
			lines = append(lines, visual...)
		}
		if item.Note != "" {
			add(theme.Fg("muted", inlineText(item.Note)))
		}
		if item.ToolReportedError {
			add(theme.Fg("warning", "File change observed, but the tool reported an error or cancellation."))
		}
	}
	if shown < len(changes) {
		add(theme.Fg("muted", fmt.Sprintf("… (%d more changes, expand tool output)", len(changes)-shown)))
	}
	return lines
}

func truncateText(text string, width int) string {
	lines := wrapText(text, width)
	if len(lines) == 0 {
		return ""
	}
	if len(lines) == 1 {
		return lines[0]
	}
	// Wrap the first line again with room for the ellipsis, without cutting ANSI.
	if width == 1 {
		return "…"
	}
	short := wrapText(lines[0], width-1)
	return short[0] + "…"
}
