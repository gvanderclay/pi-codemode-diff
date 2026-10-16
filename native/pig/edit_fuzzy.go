// SPDX-FileCopyrightText: Copyright Hewlett Packard Enterprise Development LP
// SPDX-License-Identifier: MIT
// Adapted from PiG e63c61c338e2aaf0d130513db2c2e63fe2e7dafd; see NOTICE.
package pig

import (
	"golang.org/x/text/unicode/norm"
	"strings"
)

func normalizeForFuzzyMatch(text string) string {
	// NFKC normalization first (upstream calls .normalize("NFKC")).
	text = norm.NFKC.String(text)

	// Strip trailing whitespace per line.
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \t\r")
	}
	s := strings.Join(lines, "\n")

	replacer := strings.NewReplacer(
		// Smart single quotes -> '
		"\u2018", "'", "\u2019", "'", "\u201A", "'", "\u201B", "'",
		// Smart double quotes -> "
		"\u201C", "\"", "\u201D", "\"", "\u201E", "\"", "\u201F", "\"",
		// Various dashes/hyphens -> -
		"\u2010", "-", "\u2011", "-", "\u2012", "-",
		"\u2013", "-", "\u2014", "-", "\u2015", "-", "\u2212", "-",
		// Special spaces -> regular space (U+00A0, U+2002..U+200A, U+202F, U+205F, U+3000).
		"\u00A0", " ",
		"\u2002", " ", "\u2003", " ", "\u2004", " ", "\u2005", " ",
		"\u2006", " ", "\u2007", " ", "\u2008", " ", "\u2009", " ", "\u200A", " ",
		"\u202F", " ", "\u205F", " ", "\u3000", " ",
	)
	return replacer.Replace(s)
}
