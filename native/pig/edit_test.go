package pig

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestEditTypeScriptOracle(t *testing.T) {
	data, err := os.ReadFile("testdata/edits.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name            string
		Before, After   *string
		Input, Prepared map[string]any
		Expected        map[string]any
		Error           string
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "file.txt")
			if tc.Before != nil {
				bytes, err := hex.DecodeString(*tc.Before)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, bytes, 0600); err != nil {
					t.Fatal(err)
				}
			}
			prepared, err := prepareEditArguments(tc.Input)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(prepared, tc.Prepared) {
				t.Fatalf("prepared=%#v want %#v", prepared, tc.Prepared)
			}
			entries, err := editEntries(prepared)
			var got map[string]any
			if err == nil {
				result, editErr := editLocked(func() error { return nil }, path, "file.txt", entries)
				err = editErr
				if err == nil {
					encoded, marshalErr := json.Marshal(map[string]any{"content": result.Content, "details": result.Details})
					if marshalErr != nil {
						t.Fatal(marshalErr)
					}
					if err := json.Unmarshal(encoded, &got); err != nil {
						t.Fatal(err)
					}
				}
			}
			message := ""
			if err != nil {
				message = err.Error()
			}
			if message != tc.Error {
				t.Fatalf("error=%q want %q", message, tc.Error)
			}
			if !reflect.DeepEqual(got, tc.Expected) {
				t.Errorf("result=%#v want %#v", got, tc.Expected)
			}
			after, readErr := os.ReadFile(path)
			if tc.After == nil {
				if !os.IsNotExist(readErr) {
					t.Fatalf("unexpected file: %v", readErr)
				}
			} else if readErr != nil || hex.EncodeToString(after) != *tc.After {
				t.Fatalf("file=%x error=%v want %s", after, readErr, *tc.After)
			}
		})
	}
}

func TestFileToolsDoNotActivateDisabledTools(t *testing.T) {
	w := newFileTools(newCapture())
	for _, tool := range []struct {
		name   string
		active *bool
	}{
		{w.writeDefinition().Name, w.writeDefinition().DefaultActive},
		{w.editDefinition().Name, w.editDefinition().DefaultActive},
	} {
		if tool.active == nil || *tool.active {
			t.Fatalf("%s activates a disabled tool", tool.name)
		}
	}
}

func TestMutationQueueAllowsDifferentFiles(t *testing.T) {
	q := &mutationQueue{}
	first, err := q.reserve(filepath.Join(t.TempDir(), "first"))
	if err != nil {
		t.Fatal(err)
	}
	defer first.release()
	second, err := q.reserve(filepath.Join(t.TempDir(), "second"))
	if err != nil {
		t.Fatal(err)
	}
	defer second.release()
	select {
	case <-second.ready:
	default:
		t.Fatal("unrelated file blocked behind first")
	}
}
