// Adapted from jsdiff 8.0.4, libesm/diff/word.js (BSD-3-Clause).
// Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>. See NOTICE.
package pig

import "strings"

func jsSpace(r rune) bool {
	return r >= 9 && r <= 13 || r == ' ' || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func wordChar(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == 0xad || r >= 0xc0 && r <= 0xd6 || r >= 0xd8 && r <= 0xf6 || r >= 0xf8 && r <= 0x2c6 || r >= 0x2c8 && r <= 0x2d7 || r >= 0x2de && r <= 0x2ff || r >= 0x1e00 && r <= 0x1eff
}
func leadingWS(s string) string  { return s[:len(s)-len(strings.TrimLeftFunc(s, jsSpace))] }
func trailingWS(s string) string { return s[len(strings.TrimRightFunc(s, jsSpace)):] }

func wordTokens(s string) []string {
	var parts []string
	var current strings.Builder
	class := 0
	for _, r := range s {
		next := 3
		if jsSpace(r) {
			next = 1
		} else if wordChar(r) {
			next = 2
		}
		if current.Len() > 0 && (next != class || next == 3) {
			parts = append(parts, current.String())
			current.Reset()
		}
		current.WriteRune(r)
		class = next
	}
	if current.Len() > 0 {
		parts = append(parts, current.String())
	}
	var tokens []string
	previous := ""
	for _, part := range parts {
		if strings.IndexFunc(part, jsSpace) >= 0 {
			if previous == "" {
				tokens = append(tokens, part)
			} else {
				tokens[len(tokens)-1] += part
			}
		} else if previous != "" && strings.IndexFunc(previous, jsSpace) >= 0 {
			if tokens[len(tokens)-1] == previous {
				tokens[len(tokens)-1] += part
			} else {
				tokens = append(tokens, previous+part)
			}
		} else {
			tokens = append(tokens, part)
		}
		previous = part
	}
	return tokens
}

func diffWords(old, new []string, budget int) []diffComp {
	join := func(tokens []string) string {
		var b strings.Builder
		for i, token := range tokens {
			if i > 0 {
				token = strings.TrimLeftFunc(token, jsSpace)
			}
			b.WriteString(token)
		}
		return b.String()
	}
	parts := diffTokens(old, new, budget, func(a, b string) bool { return strings.TrimFunc(a, jsSpace) == strings.TrimFunc(b, jsSpace) }, join)
	var keep, deletion, insertion *diffComp
	for i := range parts {
		part := &parts[i]
		if part.added {
			insertion = part
		} else if part.removed {
			deletion = part
		} else {
			if deletion != nil || insertion != nil {
				dedupeWhitespace(keep, deletion, insertion, part)
			}
			keep = part
			deletion = nil
			insertion = nil
		}
	}
	if deletion != nil || insertion != nil {
		dedupeWhitespace(keep, deletion, insertion, nil)
	}
	return parts
}

func commonPrefix(a, b string) string {
	x, y := []rune(a), []rune(b)
	i := 0
	for i < min(len(x), len(y)) && x[i] == y[i] {
		i++
	}
	return string(x[:i])
}
func commonSuffix(a, b string) string {
	x, y := []rune(a), []rune(b)
	i := 0
	for i < min(len(x), len(y)) && x[len(x)-1-i] == y[len(y)-1-i] {
		i++
	}
	return string(x[len(x)-i:])
}

// Linear prefix-function overlap keeps pathological whitespace runs bounded.
func maximumOverlap(a, b string) string {
	s := []rune(b + "\x00" + a)
	prefix := make([]int, len(s))
	for i := 1; i < len(s); i++ {
		j := prefix[i-1]
		for j > 0 && s[i] != s[j] {
			j = prefix[j-1]
		}
		if s[i] == s[j] {
			j++
		}
		prefix[i] = j
	}
	return string([]rune(b)[:prefix[len(prefix)-1]])
}

func dedupeWhitespace(start, deleted, inserted, end *diffComp) {
	switch {
	case deleted != nil && inserted != nil:
		oldPrefix, oldSuffix := leadingWS(deleted.value), trailingWS(deleted.value)
		newPrefix, newSuffix := leadingWS(inserted.value), trailingWS(inserted.value)
		if start != nil {
			common := commonPrefix(oldPrefix, newPrefix)
			start.value = strings.TrimSuffix(start.value, newPrefix) + common
			deleted.value = strings.TrimPrefix(deleted.value, common)
			inserted.value = strings.TrimPrefix(inserted.value, common)
		}
		if end != nil {
			common := commonSuffix(oldSuffix, newSuffix)
			end.value = common + strings.TrimPrefix(end.value, newSuffix)
			deleted.value = strings.TrimSuffix(deleted.value, common)
			inserted.value = strings.TrimSuffix(inserted.value, common)
		}
	case inserted != nil:
		if start != nil {
			inserted.value = strings.TrimLeftFunc(inserted.value, jsSpace)
		}
		if end != nil {
			end.value = strings.TrimLeftFunc(end.value, jsSpace)
		}
	case start != nil && end != nil:
		full := leadingWS(end.value)
		prefix := commonPrefix(full, leadingWS(deleted.value))
		deleted.value = strings.TrimPrefix(deleted.value, prefix)
		suffix := commonSuffix(strings.TrimPrefix(full, prefix), trailingWS(deleted.value))
		deleted.value = strings.TrimSuffix(deleted.value, suffix)
		end.value = suffix + strings.TrimPrefix(end.value, full)
		start.value = strings.TrimSuffix(start.value, full) + full[:len(full)-len(suffix)]
	case end != nil:
		overlap := maximumOverlap(trailingWS(deleted.value), leadingWS(end.value))
		deleted.value = strings.TrimSuffix(deleted.value, overlap)
	case start != nil:
		overlap := maximumOverlap(trailingWS(start.value), leadingWS(deleted.value))
		deleted.value = strings.TrimPrefix(deleted.value, overlap)
	}
}
