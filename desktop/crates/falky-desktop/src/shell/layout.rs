use crate::ui_contract::Viewport;
use iced::{Rectangle, Size};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fit {
    pub size: f32,
    pub columns: usize,
}

/// The largest tiles that fit. Near ties use fewer columns, as on the web.
pub fn fit_blocks(count: usize, width: f32, height: f32, gap: f32, max_size: f32) -> Fit {
    let mut best = 0.0;
    let mut columns = 1;
    for candidate in 1..=count {
        let rows = count.div_ceil(candidate);
        let (candidate, rows) = (candidate as f32, rows as f32);
        let by_width = (width - (candidate - 1.0) * gap) / candidate;
        let by_height = (height - (rows - 1.0) * gap) / rows;
        let size = by_width.min(by_height);
        if size > best + 0.5 {
            best = size;
            columns = candidate as usize;
        }
    }
    Fit {
        size: best.min(max_size).floor().max(0.0),
        columns,
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Layout {
    pub size: Size,
    pub compact: bool,
    pub tiny: bool,
    pub room_height: f32,
    pub dock_bottom: f32,
    pub dock_pad: f32,
    pub dock_gap: f32,
    pub control_size: f32,
}

impl Layout {
    pub fn new(viewport: Viewport, rooms_open: bool) -> Self {
        let width = viewport.width.max(1.0);
        let height = viewport.height.max(1.0);
        let compact = width <= 1000.0;
        let tiny = width <= 420.0;
        Self {
            size: Size::new(width, height),
            compact,
            tiny,
            room_height: match (compact, rooms_open) {
                (false, false) => 112.0,
                (true, false) => 96.0,
                (false, true) => 152.0,
                (true, true) => 136.0,
            },
            dock_bottom: if compact { 34.0 } else { 20.0 },
            dock_pad: if compact { 8.0 } else { 10.0 },
            dock_gap: if tiny {
                4.0
            } else if compact {
                6.0
            } else {
                8.0
            },
            control_size: if tiny {
                44.0
            } else if compact {
                48.0
            } else {
                56.0
            },
        }
    }

    pub fn stage(self, count: usize, rooms_open: bool) -> (Fit, f32, f32) {
        let gap = if count > 4 { 12.0 } else { 16.0 };
        let side = if self.size.width <= 1180.0 {
            12.0
        } else {
            24.0
        };
        let reserve = if self.compact { 104.0 } else { 128.0 };
        let height = self.size.height - self.room_height - reserve - 16.0;
        let limit = if rooms_open { 414.0 } else { 460.0 };
        let fit = fit_blocks(count, self.size.width - side * 2.0, height, gap, limit);
        (fit, gap, reserve)
    }

    pub fn dock_top(self) -> f32 {
        self.size.height - self.dock_bottom - self.control_size - self.dock_pad * 2.0
    }

    pub fn chat(self, chat_button_left: f32) -> Rectangle {
        let bottom = (self.dock_top() - 12.0).max(13.0);
        if self.size.width <= 1180.0 {
            return Rectangle {
                x: 12.0,
                y: 12.0,
                width: (self.size.width - 24.0).max(1.0),
                height: (bottom - 12.0).max(1.0),
            };
        }

        let width = 380.0;
        let height = (bottom - 136.0).clamp(1.0, 540.0);
        Rectangle {
            x: (chat_button_left - 12.0).clamp(16.0, self.size.width - width - 16.0),
            y: bottom - height,
            width,
            height,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_two_side_by_side_on_wide_stage() {
        assert_eq!(
            fit_blocks(2, 1000.0, 640.0, 16.0, 460.0),
            Fit {
                columns: 2,
                size: 460.0
            }
        );
    }

    #[test]
    fn chooses_two_rows_and_keeps_the_gaps_inside_the_window() {
        assert_eq!(fit_blocks(4, 900.0, 640.0, 16.0, 460.0).columns, 2);
        let fit = fit_blocks(8, 930.0, 640.0, 12.0, 460.0);
        assert_eq!(fit.columns, 4);
        assert!(fit.size * 4.0 + 36.0 <= 930.0);
    }

    #[test]
    fn stacks_on_phone_and_answers_for_tiny_or_empty_stage() {
        assert_eq!(fit_blocks(2, 351.0, 620.0, 16.0, 460.0).columns, 1);
        assert_eq!(fit_blocks(0, 900.0, 600.0, 16.0, 460.0).size, 0.0);
        assert_eq!(fit_blocks(8, 10.0, 10.0, 16.0, 460.0).size, 0.0);
    }

    #[test]
    fn unfolded_strip_yields_space_and_chat_drawer_leaves_the_dock_accessible() {
        let viewport = Viewport {
            width: 420.0,
            height: 800.0,
        };
        let closed = Layout::new(viewport, false);
        let open = Layout::new(viewport, true);
        assert!(open.stage(2, true).0.size < closed.stage(2, false).0.size);
        let drawer = open.chat(250.0);
        assert_eq!(drawer.width, 396.0);
        assert!(drawer.y + drawer.height < open.dock_top());

        let wide = Layout::new(
            Viewport {
                width: 1500.0,
                height: 900.0,
            },
            false,
        );
        let card = wide.chat(800.0);
        assert_eq!((card.x, card.width, card.height), (788.0, 380.0, 540.0));
    }
}
