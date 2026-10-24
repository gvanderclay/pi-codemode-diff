package pig

// Only these exact orchestrators establish capture roots, never name prefixes.
func isCodemodeTool(name string) bool {
	return name == "codemode" || name == "codemode_o"
}

// Entries written before toolName was recorded belong to native codemode.
func entryToolName(data map[string]any) string {
	if name := str(data, "toolName"); isCodemodeTool(name) {
		return name
	}
	return "codemode"
}
