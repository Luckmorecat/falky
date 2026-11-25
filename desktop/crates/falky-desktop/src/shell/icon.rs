use iced::Color;
use iced::widget::svg::{Handle, Style, Svg};
use std::sync::OnceLock;

macro_rules! define_icons {
    ($($name:ident => $filename:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub enum Icon {
            $($name),+
        }

        fn handle(name: Icon) -> Handle {
            match name {
                $(Icon::$name => {
                    static HANDLE: OnceLock<Handle> = OnceLock::new();
                    HANDLE.get_or_init(|| Handle::from_memory(
                        include_bytes!(concat!("../../assets/icons/", $filename)).as_slice()
                    )).clone()
                }),+
            }
        }
    };
}

define_icons! {
    Mic => "mic.svg",
    MicOff => "micOff.svg",
    Qr => "qr.svg",
    Play => "play.svg",
    Speaker => "speaker.svg",
    Person => "person.svg",
    Key => "key.svg",
    Keyboard => "keyboard.svg",
    SpeakerOff => "speakerOff.svg",
    Head => "head.svg",
    HeadOff => "headOff.svg",
    Screen => "screen.svg",
    Camera => "camera.svg",
    Sliders => "sliders.svg",
    Check => "check.svg",
    X => "x.svg",
    Plus => "plus.svg",
    Smile => "smile.svg",
    Knock => "knock.svg",
    Reply => "reply.svg",
    Edit => "edit.svg",
    Dots => "dots.svg",
    Copy => "copy.svg",
    Trash => "trash.svg",
    Chat => "chat.svg",
    Send => "send.svg",
    Down => "down.svg",
    Chevron => "chevron.svg",
    Expand => "expand.svg",
    Image => "image.svg",
    ImageOff => "imageOff.svg",
    Left => "left.svg",
    Right => "right.svg",
    ZoomIn => "zoomIn.svg",
    ZoomOut => "zoomOut.svg",
    Retry => "retry.svg",
    Collapse => "collapse.svg",
}

/// Paints a Falky icon with its original 24px viewBox and 2px stroke.
pub fn icon<'a>(name: Icon, size: f32, color: Color) -> Svg<'a> {
    Svg::new(handle(name))
        .width(size)
        .height(size)
        .style(move |_, _| Style { color: Some(color) })
}
