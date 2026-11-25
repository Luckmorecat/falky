use crate::ui_contract::Language;

#[derive(Clone, Copy)]
pub(super) struct CopyText(Language);

impl CopyText {
    pub fn new(language: Language) -> Self {
        Self(language)
    }

    fn t(self, en: &'static str, uk: &'static str) -> &'static str {
        match self.0 {
            Language::En => en,
            Language::Uk => uk,
        }
    }

    pub fn in_voice(self, duration: &str) -> String {
        format!("{} {duration}", self.t("In voice", "У голосі"))
    }

    pub fn elsewhere(self, room: &str) -> String {
        format!(
            "{} {room}",
            self.t("You're in voice in", "Ти зараз у голосі кімнати")
        )
    }

    pub fn voice_count(self, count: usize) -> String {
        format!("{} {count}", self.t("In voice:", "У голосі:"))
    }
}

macro_rules! copy {
    ($($name:ident: $en:literal, $uk:literal;)*) => {
        impl CopyText {
            $(pub fn $name(self) -> &'static str { self.t($en, $uk) })*
        }
    };
}

copy! {
    rooms: "Rooms", "Кімнати";
    no_rooms: "No rooms yet", "Кімнат ще немає";
    no_rooms_body: "The server owner creates them.", "Їх створює власник сервера.";
    nobody: "Nobody in voice", "У голосі нікого немає";
    outside: "You're not in voice yet", "Ти поки не в голосі";
    quiet: "It's quiet here", "Тут тихо";
    quiet_body: "Join first, and others will see you in the room list.", "Приєднуйся першим, а інші побачать тебе в списку кімнат.";
    new_messages: "New messages", "Нові повідомлення";
    join: "Join", "Приєднатися";
    joining: "Joining", "Під'єднуємось";
    move_here: "Move here", "Перейти сюди";
    settings: "Settings", "Налаштування";
    chat: "Chat", "Чат";
    close_chat: "Close chat", "Закрити чат";
    leave: "Leave", "Вийти";
    leave_voice: "Leave voice", "Вийти з голосу";
    confirm_leave: "Leave voice?", "Вийти з голосу?";
    cancel: "Cancel", "Скасувати";
    mute: "Mute microphone", "Вимкнути мікрофон";
    unmute: "Unmute microphone", "Увімкнути мікрофон";
    deafen: "Turn sound off", "Вимкнути звук";
    undeafen: "Turn sound on", "Увімкнути звук";
    ptt: "Hold to talk", "Тримай, щоб говорити";
    muted: "microphone off", "мікрофон вимкнено";
    deafened: "can't hear", "не чує";
    locally_muted: "Muted for you", "Звук вимкнено для тебе";
    camera: "Camera on", "Камеру увімкнено";
    screen_share: "Sharing screen", "Показує екран";
    volume: "Volume", "Гучність";
    reconnecting: "Reconnecting", "Відновлюємо зв'язок";
    reconnecting_voice: "Reconnecting voice", "Відновлюємо голос";
    listen_only: "Listening only", "Тільки слухаєш";
}
