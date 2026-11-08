CREATE TABLE visitor_colours (
    visitor_id TEXT PRIMARY KEY REFERENCES visitors(id),
    palette TEXT NOT NULL CHECK (palette IN ('sky', 'apricot', 'lagoon', 'rose', 'violet', 'amber', 'moss', 'coral', 'indigo', 'plum', 'sunset', 'aurora', 'lime', 'clay', 'ocean', 'ruby')),
    revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;
