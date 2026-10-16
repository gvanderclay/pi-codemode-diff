// SPDX-FileCopyrightText: Copyright Hewlett Packard Enterprise Development LP
// SPDX-License-Identifier: MIT
// Adapted from PiG e63c61c338e2aaf0d130513db2c2e63fe2e7dafd; see NOTICE.
package pig

import (
	"math"
	"strings"
)

type diffComp struct {
	value   string
	added   bool
	removed bool
	count   int
	lines   []string // nil until computed; the sentinel carries an empty slice
}

// ─── line tokenizer (diff/line.js tokenize, line mode) ─────────────────────────

// tokenizeLines splits text into line tokens, each including its trailing
// newline (\n or \r\n); the final line has no terminator when text does not
// end in a newline. Mirrors jsdiff's line tokenizer after removeEmpty (no
// empty tokens arise from this input).
func tokenizeLines(text string) []string {
	if text == "" {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			out = append(out, text[start:i+1])
			start = i + 1
		}
	}
	if start < len(text) {
		out = append(out, text[start:])
	}
	return out
}

// ─── Myers diff (diff/base.js) ─────────────────────────────────────────────────

type pathComponent struct {
	count   int
	added   bool
	removed bool
	prev    *pathComponent
}

type pathNode struct {
	oldPos int
	last   *pathComponent
}

func myersLineDiff(oldStr, newStr string) []diffComp {
	oldTokens := tokenizeLines(oldStr)
	newTokens := tokenizeLines(newStr)
	return myersTokens(oldTokens, newTokens, len(oldTokens)+len(newTokens))
}

func myersTokens(oldTokens, newTokens []string, budget int) []diffComp {
	return diffTokens(oldTokens, newTokens, budget, func(a, b string) bool { return a == b }, func(tokens []string) string { return strings.Join(tokens, "") })
}

func diffTokens(oldTokens, newTokens []string, budget int, equal func(string, string) bool, join func([]string) string) []diffComp {
	oldLen := len(oldTokens)
	newLen := len(newTokens)

	maxEditLength := min(newLen+oldLen, budget)
	bestPath := map[int]*pathNode{0: {oldPos: -1}}

	newPos := extractCommon(bestPath[0], newTokens, oldTokens, 0, equal)
	if bestPath[0].oldPos+1 >= oldLen && newPos+1 >= newLen {
		return buildValues(bestPath[0].last, newTokens, oldTokens, join)
	}

	minDiagonal, maxDiagonal := math.MinInt, math.MaxInt
	for editLength := 1; editLength <= maxEditLength; editLength++ {
		lo := max(minDiagonal, -editLength)
		for diagonal := lo; diagonal <= min(maxDiagonal, editLength); diagonal += 2 {
			removePath := bestPath[diagonal-1]
			addPath := bestPath[diagonal+1]
			if removePath != nil {
				delete(bestPath, diagonal-1)
			}

			canAdd := false
			if addPath != nil {
				addPathNewPos := addPath.oldPos - diagonal
				canAdd = addPathNewPos >= 0 && addPathNewPos < newLen
			}
			canRemove := removePath != nil && removePath.oldPos+1 < oldLen
			if !canAdd && !canRemove {
				delete(bestPath, diagonal)
				continue
			}

			var basePath *pathNode
			if !canRemove || (canAdd && removePath.oldPos < addPath.oldPos) {
				basePath = addToPath(addPath, true, false, 0)
			} else {
				basePath = addToPath(removePath, false, true, 1)
			}

			newPos = extractCommon(basePath, newTokens, oldTokens, diagonal, equal)
			if basePath.oldPos+1 >= oldLen && newPos+1 >= newLen {
				return buildValues(basePath.last, newTokens, oldTokens, join)
			}
			bestPath[diagonal] = basePath
			if basePath.oldPos+1 >= oldLen {
				maxDiagonal = min(maxDiagonal, diagonal-1)
			}
			if newPos+1 >= newLen {
				minDiagonal = max(minDiagonal, diagonal+1)
			}
		}
	}
	return nil
}

func addToPath(path *pathNode, added, removed bool, oldPosInc int) *pathNode {
	last := path.last
	if last != nil && last.added == added && last.removed == removed {
		return &pathNode{
			oldPos: path.oldPos + oldPosInc,
			last:   &pathComponent{count: last.count + 1, added: added, removed: removed, prev: last.prev},
		}
	}
	return &pathNode{
		oldPos: path.oldPos + oldPosInc,
		last:   &pathComponent{count: 1, added: added, removed: removed, prev: last},
	}
}

func extractCommon(basePath *pathNode, newTokens, oldTokens []string, diagonal int, equal func(string, string) bool) int {
	newLen := len(newTokens)
	oldLen := len(oldTokens)
	oldPos := basePath.oldPos
	newPos := oldPos - diagonal
	commonCount := 0
	for newPos+1 < newLen && oldPos+1 < oldLen && equal(oldTokens[oldPos+1], newTokens[newPos+1]) {
		newPos++
		oldPos++
		commonCount++
	}
	if commonCount > 0 {
		basePath.last = &pathComponent{count: commonCount, prev: basePath.last}
	}
	basePath.oldPos = oldPos
	return newPos
}

func buildValues(last *pathComponent, newTokens, oldTokens []string, join func([]string) string) []diffComp {
	var comps []*pathComponent
	for last != nil {
		comps = append(comps, last)
		last = last.prev
	}
	// Reverse into forward order.
	for i, j := 0, len(comps)-1; i < j; i, j = i+1, j-1 {
		comps[i], comps[j] = comps[j], comps[i]
	}

	out := make([]diffComp, 0, len(comps))
	newPos, oldPos := 0, 0
	for _, c := range comps {
		var value string
		if !c.removed {
			value = join(newTokens[newPos : newPos+c.count])
			newPos += c.count
			if !c.added {
				oldPos += c.count
			}
		} else {
			value = join(oldTokens[oldPos : oldPos+c.count])
			oldPos += c.count
		}
		out = append(out, diffComp{value: value, added: c.added, removed: c.removed, count: c.count})
	}
	return out
}
