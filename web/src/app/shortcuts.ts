/** Current bindings and their tooltip labels, shared with the keyboard hook. */
export const shortcuts = {
  mute: { code: 'KeyM', label: 'M' },
  deafen: { code: 'KeyD', label: 'D' },
  camera: { code: 'KeyV', label: 'V' },
  chat: { code: 'Slash', key: '/', label: '/' },
  chatEnter: { code: 'Enter', label: 'Enter' },
  previousRoom: { key: 'ArrowLeft', label: '←' },
  nextRoom: { key: 'ArrowRight', label: '→' },
  closeRooms: { key: 'Escape', label: 'Esc' },
} as const;
