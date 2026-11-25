use chrono::Utc;
use iced::{
    Color, Element, Fill, Theme,
    alignment::Horizontal,
    widget::{
        Column, button, center, column, container, qr_code, row, scrollable, text, text_input,
    },
};

use super::{Login, Message, Notice, Operation};
use crate::{locale, ui_contract::Language};
use falky_core::{model::SignInState, session::Error, transport::OriginError};

pub(super) fn login(login: &Login, language: Language) -> Element<'_, Message> {
    let mut body = if login.candidate.is_some() {
        qr(login, language)
    } else {
        server(login, language)
    };
    if let Some(notice) = login.notice {
        body = body.push(note(match notice {
            Notice::Revoked => copy(
                language,
                "Your session ended. Scan a new QR code to sign in again.",
                "Сеанс завершено. Відскануй новий QR-код, щоб знову ввійти.",
            ),
            Notice::MemoryOnly => memory_only(language),
            Notice::LogoutUnconfirmed => locale::text(language, locale::Key::AccountSignOutUnknown),
            Notice::CancelUnconfirmed => copy(
                language,
                "The server could not confirm cancellation of the sign-in request.",
                "Сервер не зміг підтвердити скасування запиту на вхід.",
            ),
        }));
    }
    if login.origin_error {
        body = body.push(note(copy(
            language,
            "Could not remember the server on this device.",
            "Не вдалося зберегти адресу сервера на цьому пристрої.",
        )));
    }
    if login.storage_error {
        body = body.push(note(copy(
            language,
            "Could not remove the saved session from the system keyring.",
            "Не вдалося видалити збережений сеанс із системного сховища.",
        )));
    }
    let body = container(body.spacing(16).align_x(Horizontal::Center))
        .padding(24)
        .max_width(420);
    center(scrollable(container(body).center_x(Fill)))
        .width(Fill)
        .height(Fill)
        .into()
}

fn server(login: &Login, language: Language) -> Column<'_, Message> {
    let mut body = column![
        title(copy(language, "Falky server", "Сервер Falky")),
        note(copy(
            language,
            "Enter the server address to sign in.",
            "Введи адресу сервера, щоб увійти."
        )),
        text_input("https://falky.example", &login.input)
            .on_input(Message::OriginEdited)
            .on_submit(Message::Connect)
            .padding(12),
        action(
            copy(language, "Continue", "Далі"),
            Some(Message::Connect),
            true
        ),
    ];
    if let Some(error) = login.invalid_origin {
        body = body.push(problem(match error {
            OriginError::Invalid => copy(
                language,
                "Enter a server origin such as https://falky.example.",
                "Введи адресу сервера, наприклад https://falky.example.",
            ),
            OriginError::RequiresHttps => copy(
                language,
                "Use HTTPS, or HTTP with localhost or 127.0.0.1.",
                "Використовуй HTTPS або HTTP з localhost чи 127.0.0.1.",
            ),
        }));
    } else if login.problem.is_some() {
        body = body.push(problem(request_failed(language)));
    }
    body
}

fn qr(login: &Login, language: Language) -> Column<'_, Message> {
    let state = login.request.as_ref().map(|request| request.state);
    let terminal =
        login.expired() || matches!(state, Some(SignInState::Denied | SignInState::Cancelled));
    let busy = login.op.is_some_and(|op| op != Operation::Poll);
    let waiting_for_restore = login.op == Some(Operation::Restore);
    let request_visible = login.qr.is_some() && login.pending_qr() && !busy;
    let heading = if login.op == Some(Operation::Finish) {
        copy(language, "Finishing sign-in…", "Завершуємо вхід…")
    } else if login.expired() {
        copy(language, "This request has expired.", "Час запиту минув.")
    } else {
        match state {
            Some(SignInState::Denied) => copy(language, "Sign-in denied.", "Вхід відхилено."),
            Some(SignInState::Cancelled) => copy(
                language,
                "This request was cancelled.",
                "Цей запит скасовано.",
            ),
            _ => copy(language, "Bring your voice here.", "Твій голос — і тут."),
        }
    };
    let mut body = column![title(heading)];
    if request_visible {
        if let Some(data) = &login.qr {
            body = body.push(note(copy(
                language,
                "Scan this code from Falky on your signed-in device.",
                "Відскануй цей код у Falky на пристрої, де вже є вхід.",
            )));
            body = body.push(
                container(qr_code(data).total_size(214).style(|_| qr_code::Style {
                    cell: Color::BLACK,
                    background: Color::WHITE,
                }))
                .padding(7)
                .style(|_| {
                    container::Style::default()
                        .background(Color::WHITE)
                        .border(iced::border::rounded(18))
                }),
            );
        }
        if login.pending_qr() {
            let expires_at = login
                .request
                .as_ref()
                .expect("a pending request exists")
                .expires_at;
            let seconds = (expires_at - Utc::now())
                .to_std()
                .unwrap_or_default()
                .as_millis()
                .div_ceil(1000);
            let waiting = copy(language, "Waiting for approval", "Очікуємо підтвердження");
            let expiry = copy(language, "Expires in", "Залишилося");
            body = body.push(note(format!(
                "{waiting} · {expiry} {}:{:02}",
                seconds / 60,
                seconds % 60
            )));
        }
        body = body.push(note(copy(
            language,
            "Open Settings → Account → Scan QR code on that device.",
            "На тому пристрої відкрий Налаштування → Обліковий запис → Сканувати QR-код.",
        )));
    } else if busy {
        body = body.push(note(copy(language, "Loading…", "Завантажуємо…")));
    }
    if let Some(issue) = &login.problem {
        let label = match &issue.error {
            Error::OutcomeUnknown if login.retry_cancel => copy(
                language,
                "Could not confirm cancellation. Retry the same request.",
                "Не вдалося підтвердити скасування. Повтори той самий запит.",
            ),
            Error::OutcomeUnknown => copy(
                language,
                "Could not confirm sign-in. Retry the same request.",
                "Не вдалося підтвердити вхід. Повтори той самий запит.",
            ),
            Error::Expired => copy(language, "This request has expired.", "Час запиту минув."),
            Error::Api(error)
                if error.retry_after().is_some() || error.code() == Some("rate_limited") =>
            {
                copy(
                    language,
                    "Please wait before trying again.",
                    "Зачекай перед наступною спробою.",
                )
            }
            Error::Api(error) if error.code() == Some("invalid_proof") => copy(
                language,
                "This request is unavailable or has expired.",
                "Запит недоступний або його час минув.",
            ),
            _ => request_failed(language),
        };
        let remaining = issue
            .retry_at
            .map(|deadline| deadline.saturating_duration_since(std::time::Instant::now()));
        body = body.push(problem(match remaining {
            Some(remaining) if !remaining.is_zero() => {
                let seconds = remaining.as_millis().div_ceil(1000);
                format!("{label} {}:{:02}", seconds / 60, seconds % 60)
            }
            _ => label.to_owned(),
        }));
    }
    if terminal || login.problem.is_some() || (!request_visible && !busy) {
        let label = if login.resolve_delivery
            || login.retry_cancel
            || login.restore_failed
            || login.problem.is_some() && !terminal
        {
            copy(language, "Try again", "Спробувати ще раз")
        } else {
            copy(language, "Create a new QR code", "Створити новий QR-код")
        };
        body = body.push(action(
            label,
            (!busy && !login.blocked()).then_some(Message::Retry),
            true,
        ));
    }
    let can_cancel = !busy && (login.binding_uncertain() || login.request.is_some() && !terminal);
    let change = !busy || waiting_for_restore;
    body.push(
        row![
            action(
                copy(language, "Cancel", "Скасувати"),
                can_cancel.then_some(Message::Cancel),
                false
            ),
            action(
                copy(language, "Change server", "Змінити сервер"),
                change.then_some(Message::ChangeServer),
                false
            ),
        ]
        .spacing(8),
    )
}

fn title<'a>(label: &'static str) -> iced::widget::Text<'a> {
    text(label).size(30).align_x(Horizontal::Center)
}

fn note<'a>(label: impl Into<iced::widget::text::Fragment<'a>>) -> iced::widget::Text<'a> {
    text(label.into())
        .size(14)
        .align_x(Horizontal::Center)
        .style(|theme: &Theme| iced::widget::text::Style {
            color: Some(
                theme
                    .extended_palette()
                    .background
                    .base
                    .text
                    .scale_alpha(0.72),
            ),
        })
}

fn problem<'a>(label: impl iced::widget::text::IntoFragment<'a>) -> iced::widget::Text<'a> {
    text(label)
        .size(14)
        .align_x(Horizontal::Center)
        .style(iced::widget::text::danger)
}

fn action<'a>(
    label: &'static str,
    message: Option<Message>,
    primary: bool,
) -> button::Button<'a, Message> {
    button(text(label).size(14))
        .padding([10, 14])
        .on_press_maybe(message)
        .style(move |theme, status| {
            let mut style = if primary {
                button::primary(theme, status)
            } else {
                button::secondary(theme, status)
            };
            if primary {
                let palette = theme.extended_palette();
                style.background = Some(
                    palette
                        .background
                        .base
                        .text
                        .scale_alpha(if status == button::Status::Disabled {
                            0.35
                        } else {
                            1.0
                        })
                        .into(),
                );
                style.text_color = palette.background.base.color;
            }
            style.border.radius = 13.0.into();
            style
        })
}

pub(super) fn memory_only(language: Language) -> &'static str {
    copy(
        language,
        "The system keyring is unavailable. Scan again the next time you open Falky.",
        "Системне сховище недоступне. Наступного разу після запуску Falky відскануй код знову.",
    )
}

pub(super) fn session_in_memory(language: Language) -> &'static str {
    copy(
        language,
        "This session is kept in memory. You may need to scan a QR code the next time you open Falky.",
        "Цей сеанс збережено в пам’яті. Наступного разу після запуску Falky може знадобитися знову відсканувати QR-код.",
    )
}

fn request_failed(language: Language) -> &'static str {
    copy(
        language,
        "Could not update this request. Try again.",
        "Не вдалося оновити запит. Спробуй ще раз.",
    )
}

fn copy(language: Language, en: &'static str, uk: &'static str) -> &'static str {
    match language {
        Language::En => en,
        Language::Uk => uk,
    }
}
