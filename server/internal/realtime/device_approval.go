package realtime

// EndRequest sends a final sanitized hint, then closes every registered upgrade
// for this request. The caller holds the lifecycle gate.
func (h *Hub) EndRequest(requestID string, notice []byte) {
	if requestID == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns {
		if c.sub.RequestID == requestID {
			c.notice = notice
			h.removeLocked(c, StatusRevoked, "request terminal")
		}
	}
}
