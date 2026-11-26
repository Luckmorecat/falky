use iced::widget::Stack;
use iced::widget::canvas::{self, Canvas, Geometry, Path};
use iced::{Color, Element, Fill, Point, Rectangle, Renderer, Size, Theme, mouse};
use std::cell::Cell;
use std::f32::consts::FRAC_PI_2;

pub const SQUIRCLE_N: f32 = 3.4;
const DOT_PITCH: f32 = 20.0;

/// The outer corner grows by the same distance as the inset.
pub fn outer_radius(inner: f32, padding: f32) -> f32 {
    inner + padding
}

fn outline(size: Size, radius: f32) -> Path {
    let radius = radius.clamp(0.0, size.width.min(size.height) / 2.0);
    if radius == 0.0 {
        return Path::rectangle(Point::ORIGIN, size);
    }
    let centers = [
        Point::new(size.width - radius, size.height - radius),
        Point::new(radius, size.height - radius),
        Point::new(radius, radius),
        Point::new(size.width - radius, radius),
    ];

    Path::new(|path| {
        for (quadrant, center) in centers.into_iter().enumerate() {
            for step in 0..=16 {
                let angle = (quadrant as f32 + step as f32 / 16.0) * FRAC_PI_2;
                let offset = squircle_point(angle, radius);
                let point = Point::new(center.x + offset.x, center.y + offset.y);
                if quadrant == 0 && step == 0 {
                    path.move_to(point);
                } else {
                    path.line_to(point);
                }
            }
        }
        path.close();
    })
}

fn squircle_point(angle: f32, radius: f32) -> Point {
    let (sin, cos) = angle.sin_cos();
    let offset =
        |direction: f32| radius * direction.abs().powf(2.0 / SQUIRCLE_N).copysign(direction);
    Point::new(offset(cos), offset(sin))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Shape {
    pub fill: Color,
    pub radius: f32,
}

#[derive(Default)]
pub(super) struct ShapeCache {
    shape: Cell<Option<Shape>>,
    mesh: canvas::Cache,
}

impl<Message> canvas::Program<Message> for Shape {
    type State = ShapeCache;

    fn draw(
        &self,
        state: &Self::State,
        renderer: &Renderer,
        _: &Theme,
        bounds: Rectangle,
        _: mouse::Cursor,
    ) -> Vec<Geometry> {
        if state.shape.replace(Some(*self)) != Some(*self) {
            state.mesh.clear();
        }
        vec![state.mesh.draw(renderer, bounds.size(), |frame| {
            frame.fill(&outline(bounds.size(), self.radius), self.fill);
        })]
    }
}

pub(super) fn surface<'a, Message: 'a>(
    content: impl Into<Element<'a, Message>>,
    radius: f32,
    fill: Color,
) -> Stack<'a, Message> {
    Stack::new()
        .push(content)
        .push_under(Canvas::new(Shape { fill, radius }).width(Fill).height(Fill))
}

pub(super) struct DotGrid {
    pub background: Color,
    pub dot: Color,
}

#[derive(Default)]
pub(super) struct DotCache {
    colors: Cell<Option<[Color; 2]>>,
    mesh: canvas::Cache,
}

impl<Message> canvas::Program<Message> for DotGrid {
    type State = DotCache;

    fn draw(
        &self,
        state: &Self::State,
        renderer: &Renderer,
        _: &Theme,
        bounds: Rectangle,
        _: mouse::Cursor,
    ) -> Vec<Geometry> {
        let colors = [self.background, self.dot];
        if state.colors.replace(Some(colors)) != Some(colors) {
            state.mesh.clear();
        }
        let dot = blend(self.dot, self.background);
        vec![state.mesh.draw(renderer, bounds.size(), |frame| {
            frame.fill_rectangle(Point::ORIGIN, bounds.size(), self.background);
            for row in 0..(bounds.height / DOT_PITCH).ceil() as usize {
                for column in 0..(bounds.width / DOT_PITCH).ceil() as usize {
                    let x = (column as f32 + 0.5) * DOT_PITCH;
                    let y = (row as f32 + 0.5) * DOT_PITCH;
                    frame.fill(&Path::circle(Point::new(x, y), 0.95), dot);
                }
            }
        })]
    }
}

pub(super) fn blend(front: Color, background: Color) -> Color {
    let channel = |front_channel: f32, back_channel: f32| {
        front_channel * front.a + back_channel * (1.0 - front.a)
    };
    Color::from_rgb(
        channel(front.r, background.r),
        channel(front.g, background.g),
        channel(front.b, background.b),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::FRAC_PI_4;

    #[tokio::test]
    async fn squircle_cache_matches_fresh_mesh_after_style_and_size_changes() {
        use iced::advanced::{
            layout::{Layout, Limits},
            renderer::{self, Headless, Renderer as _},
            widget::Tree,
        };
        use iced::{Font, Pixels};

        fn snapshot(
            renderer: &mut Renderer,
            tree: &mut Tree,
            shape: Shape,
            size: Size<u32>,
        ) -> Vec<u8> {
            let logical = Size::new(size.width as f32, size.height as f32);
            let bounds = Rectangle::with_size(logical);
            let mut canvas: Element<'_, ()> = Canvas::new(shape).width(Fill).height(Fill).into();
            tree.diff(canvas.as_widget());
            let node =
                canvas
                    .as_widget_mut()
                    .layout(tree, renderer, &Limits::new(Size::ZERO, logical));
            renderer.reset(bounds);
            canvas.as_widget().draw(
                tree,
                renderer,
                &Theme::Dark,
                &renderer::Style::default(),
                Layout::new(&node),
                mouse::Cursor::Unavailable,
                &bounds,
            );
            renderer.screenshot(size, 1.0, Color::BLACK)
        }

        let mut renderer = Renderer::new(Font::DEFAULT, Pixels(16.0), Some("tiny-skia"))
            .await
            .unwrap();
        let mut retained = Tree::empty();
        let first = Shape {
            fill: Color::from_rgb8(120, 30, 80),
            radius: 10.0,
        };
        let hover = Shape {
            fill: Color::from_rgb8(210, 200, 60),
            ..first
        };
        let rounded = Shape {
            radius: 23.0,
            ..hover
        };
        let size = Size::new(144, 52);
        for (shape, viewport) in [
            (first, size),
            (first, size),
            (hover, size),
            (rounded, size),
            (rounded, Size::new(55, 35)),
            (first, size),
        ] {
            let cached = snapshot(&mut renderer, &mut retained, shape, viewport);
            let fresh = snapshot(&mut renderer, &mut Tree::empty(), shape, viewport);
            assert_eq!(cached, fresh, "{shape:?}, {viewport:?}");
        }
    }

    #[test]
    fn reaches_each_edge_and_corners_live_between_circle_and_square() {
        for cardinal in [0.0, 1.0, 2.0, 3.0] {
            let p = squircle_point(cardinal * FRAC_PI_2, 50.0);
            assert!((p.x.abs().max(p.y.abs()) - 50.0).abs() < 0.01);
        }
        let corner = squircle_point(FRAC_PI_4, 50.0);
        let distance = corner.x.hypot(corner.y);
        assert!((50.0..50.0 * 2.0_f32.sqrt()).contains(&distance));
        assert!(
            (corner.x.abs().powf(SQUIRCLE_N) + corner.y.abs().powf(SQUIRCLE_N)
                - 50.0_f32.powf(SQUIRCLE_N))
            .abs()
                < 1.0
        );
        assert_eq!(outer_radius(28.0, 10.0), 38.0);
    }
}
