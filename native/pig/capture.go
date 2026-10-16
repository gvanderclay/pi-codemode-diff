package pig

import (
	"slices"
	"sync"
)

type call struct {
	root  string
	order int
}
type batch struct {
	calls              []string
	changes            map[string]change
	next, bytes, lines int
}
type capture struct {
	mu      sync.Mutex
	calls   map[string]call
	batches map[string]*batch
}

func newCapture() *capture { return &capture{calls: map[string]call{}, batches: map[string]*batch{}} }

func (c *capture) start(id, name, parent string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	root := c.calls[parent].root
	if root == "" {
		if name != "codemode" {
			return
		}
		root = id
	}
	b := c.batches[root]
	if b == nil {
		b = &batch{changes: map[string]change{}}
		c.batches[root] = b
	}
	b.calls = append(b.calls, id)
	c.calls[id] = call{root, b.next}
	b.next++
}

func (c *capture) nested(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	root := c.calls[id].root
	return root != "" && root != id
}

func (c *capture) add(item change) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b := c.batches[c.calls[item.ToolCallID].root]
	if b == nil {
		return
	}
	previous := b.changes[item.ToolCallID]
	if previous.Diff != nil {
		b.bytes -= len(*previous.Diff)
		b.lines -= lineCount(*previous.Diff)
	}
	item = limitChange(item, maxBatchBytes-b.bytes, maxBatchLines-b.lines)
	if item.Diff != nil {
		b.bytes += len(*item.Diff)
		b.lines += lineCount(*item.Diff)
	}
	b.changes[item.ToolCallID] = item
}

func (c *capture) reportError(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b := c.batches[c.calls[id].root]
	if b == nil {
		return
	}
	if item, ok := b.changes[id]; ok {
		item.ToolReportedError = true
		b.changes[id] = item
	}
}

func (c *capture) details(id string) *diffDetails {
	c.mu.Lock()
	defer c.mu.Unlock()
	b := c.batches[id]
	if b == nil || len(b.changes) == 0 {
		return nil
	}
	items := make([]change, 0, len(b.changes))
	for _, item := range b.changes {
		items = append(items, item)
	}
	slices.SortFunc(items, func(a, b change) int { return c.calls[a.ToolCallID].order - c.calls[b.ToolCallID].order })
	return &diffDetails{1, items}
}

func (c *capture) end(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if b := c.batches[id]; b != nil {
		for _, id := range b.calls {
			delete(c.calls, id)
		}
		delete(c.batches, id)
	}
}
func (c *capture) clear() { c.mu.Lock(); defer c.mu.Unlock(); clear(c.calls); clear(c.batches) }
