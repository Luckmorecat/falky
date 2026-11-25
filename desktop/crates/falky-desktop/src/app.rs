use iced::widget::{center, text};
use iced::{Element, Task, window};

#[derive(Clone, Debug)]
enum Message {
    CloseRequested,
}

pub fn run() -> iced::Result {
    iced::daemon(
        boot,
        |_: &mut (), Message::CloseRequested| iced::exit(),
        view,
    )
    .title("Falky")
    .subscription(|_| window::close_requests().map(|_| Message::CloseRequested))
    .run()
}

fn boot() -> ((), Task<Message>) {
    let (_, opened) = window::open(window::Settings {
        exit_on_close_request: false,
        ..window::Settings::default()
    });
    ((), opened.discard())
}

fn view(_: &(), _: window::Id) -> Element<'_, Message> {
    center(text("Falky")).into()
}
