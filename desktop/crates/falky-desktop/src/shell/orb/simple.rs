use std::time::Duration;

use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout,
    renderer::{self, Renderer as _},
    widget::{Tree, tree},
};
use iced::animation::Easing;
use iced::{Animation, Color, Degrees, Event, Length, Rectangle, Renderer, Size, Theme};
use iced::{border, gradient, mouse, time::Instant, window};

use super::{Orb, SPEECH_SCALE, TALK_PADDING, style};

pub(super) struct SimpleOrb {
    pub orb: Orb,
    pub size: f32,
}

impl SimpleOrb {
    fn target_level(&self) -> f32 {
        if self.orb.target_level > 0.03 {
            self.orb.target_level.min(1.0)
        } else {
            0.0
        }
    }
}

struct Pulse {
    seed: u32,
    level: f32,
    animation: Animation<f32>,
}

impl Pulse {
    fn new(seed: u32, level: f32) -> Self {
        Self {
            seed,
            level,
            animation: Animation::new(level)
                .duration(Duration::from_millis(160))
                .easing(Easing::EaseOutCubic),
        }
    }
}

impl<Message> Widget<Message, Theme, Renderer> for SimpleOrb {
    fn size(&self) -> Size<Length> {
        Size::new(self.size.into(), self.size.into())
    }

    fn layout(&mut self, _: &mut Tree, _: &Renderer, limits: &layout::Limits) -> layout::Node {
        layout::atomic(limits, self.size, self.size)
    }

    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<Pulse>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(Pulse::new(self.orb.seed, self.target_level()))
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        _: mouse::Cursor,
        _: &Renderer,
        _: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        if let Event::Window(window::Event::RedrawRequested(now)) = event
            && !self.orb.still
            && layout.bounds().intersects(viewport)
        {
            self.update_pulse(tree.state.downcast_mut(), *now, shell);
        }
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        _: &Theme,
        _: &renderer::Style,
        layout: Layout<'_>,
        _: mouse::Cursor,
        _: &Rectangle,
    ) {
        let bounds = layout.bounds();
        let level = tree.state.downcast_ref::<Pulse>().level;
        let padding = if self.orb.still { 1.0 } else { TALK_PADDING };
        let diameter = bounds.width.min(bounds.height) * (1.0 + level * SPEECH_SCALE) / padding;
        let paint = |color: Color| {
            let color = if self.orb.grayscale {
                let gray = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
                Color::from_rgb(gray, gray, gray)
            } else {
                color
            };
            style::alpha(color, self.orb.opacity)
        };
        let [body, highlight, shadow, _] = self.orb.colors;
        renderer.fill_quad(
            renderer::Quad {
                bounds: Rectangle {
                    x: bounds.center_x() - diameter / 2.0,
                    y: bounds.center_y() - diameter / 2.0,
                    width: diameter,
                    height: diameter,
                },
                border: border::rounded(diameter / 2.0),
                ..renderer::Quad::default()
            },
            gradient::Linear::new(Degrees(135.0))
                .add_stop(0.0, paint(highlight))
                .add_stop(0.55, paint(body))
                .add_stop(1.0, paint(shadow)),
        );
    }
}

impl SimpleOrb {
    fn update_pulse<Message>(
        &self,
        pulse: &mut Pulse,
        now: Instant,
        shell: &mut Shell<'_, Message>,
    ) {
        let target = self.target_level();
        if pulse.seed != self.orb.seed || self.orb.reduced_motion {
            *pulse = Pulse::new(self.orb.seed, target);
            return;
        }

        pulse.animation.go_mut(target, now);
        pulse.level = pulse.animation.interpolate_with(|level| level, now);
        if pulse.animation.is_animating(now) {
            shell.request_redraw_at(now + Duration::from_millis(16));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::orb::Slot;
    use iced::window::RedrawRequest;

    #[test]
    fn speech_grows_then_settles_without_idle_redraws() {
        let now = Instant::now();
        let mut orb = SimpleOrb {
            orb: Orb {
                still: false,
                ..Orb::still(Slot::Stage(0), "speaker", [Color::WHITE; 4], 1.0)
            },
            size: 100.0,
        };
        let mut pulse = Pulse::new(orb.orb.seed, 0.0);
        let mut messages = Vec::<()>::new();
        let mut shell = Shell::new(&mut messages);
        orb.update_pulse(&mut pulse, now, &mut shell);
        assert_eq!(shell.redraw_request(), RedrawRequest::Wait);

        orb.orb.target_level = 1.0;
        orb.update_pulse(&mut pulse, now, &mut shell);
        assert_ne!(shell.redraw_request(), RedrawRequest::Wait);
        orb.update_pulse(&mut pulse, now + Duration::from_millis(80), &mut shell);
        let growing = pulse.level;
        assert!(growing > 0.0 && growing < 1.0);

        orb.orb.target_level = 0.0;
        orb.update_pulse(&mut pulse, now + Duration::from_millis(80), &mut shell);
        assert!((pulse.level - growing).abs() < 0.001);
        let mut shell = Shell::new(&mut messages);
        orb.update_pulse(&mut pulse, now + Duration::from_millis(300), &mut shell);
        assert_eq!(pulse.level, 0.0);
        assert_eq!(shell.redraw_request(), RedrawRequest::Wait);
    }
}
