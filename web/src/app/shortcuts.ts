/** Current bindings and their tooltip labels, shared with the keyboard hook. */
export const shortcuts = {
  mute: { code: 'KeyM', label: 'M' },
  deafen: { code: 'KeyD', label: 'D' },
  camera: { code: 'KeyV', label: 'V' },
  /** Digit1 sends the first reaction, Digit2 the second, and so on. */
  react: { codePrefix: 'Digit', label: '1–6' },
  chat: { code: 'Slash', key: '/', label: '/' },
  chatEnter: { code: 'Enter', label: 'Enter' },
  previousRoom: { key: 'ArrowLeft', label: '←' },
  nextRoom: { key: 'ArrowRight', label: '→' },
  closeRooms: { key: 'Escape', label: 'Esc' },
} as const;
