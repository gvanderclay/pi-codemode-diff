//go:build unix

// SPDX-FileCopyrightText: Copyright Hewlett Packard Enterprise Development LP
// SPDX-License-Identifier: MIT
// Adapted from PiG e63c61c338e2aaf0d130513db2c2e63fe2e7dafd; see NOTICE.
package pig

import "syscall"

// accessReadWrite mirrors Node fs.access(path, R_OK | W_OK).
func accessReadWrite(path string) error {
	return syscall.Access(path, 0x4|0x2)
}
