use super::{Message, PlatformEvent};
use falky_core::model::{RoomId, SessionScope};
use iced::Task;
use notify_rust::Notification;
use std::sync::Arc;
use tokio::sync::Semaphore;

pub(super) struct Notifications(Arc<Semaphore>);

impl Default for Notifications {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(8)))
    }
}

impl Notifications {
    pub(super) fn show(
        &self,
        scope: SessionScope,
        room: RoomId,
        summary: String,
        body: String,
    ) -> Task<Message> {
        let Ok(permit) = self.0.clone().try_acquire_owned() else {
            return Task::none();
        };
        let body = plain_text(&body, 160);
        #[cfg(all(unix, not(target_os = "macos")))]
        let body = body
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let mut notification = Notification::new();
        notification
            .appname("Falky")
            .summary(&plain_text(&summary, 160))
            .body(&body)
            .timeout(6_000);
        let activation = Message(PlatformEvent::NotificationOpened { scope, room });
        Task::future(os::show(notification, permit)).then(move |clicked| {
            if clicked {
                Task::done(activation.clone())
            } else {
                Task::none()
            }
        })
    }
}

fn plain_text(content: &str, limit: usize) -> String {
    content
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(limit)
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
mod os {
    use super::*;
    use std::time::Duration;
    use tokio::sync::OwnedSemaphorePermit;

    pub(super) async fn show(
        mut notification: Notification,
        _permit: OwnedSemaphorePermit,
    ) -> bool {
        notification.action("default", "");
        let Ok(Ok(handle)) =
            tokio::time::timeout(Duration::from_secs(3), notification.show_async()).await
        else {
            return false;
        };
        let mut clicked = false;
        let listening = handle.wait_for_action_async(|response| {
            clicked = response.is_default_action();
        });
        let _ = tokio::time::timeout(Duration::from_secs(60), listening).await;
        clicked
    }
}

#[cfg(target_os = "macos")]
mod os {
    use super::*;
    use tokio::sync::OwnedSemaphorePermit;

    pub(super) async fn show(notification: Notification, permit: OwnedSemaphorePermit) -> bool {
        let _ = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            // On NSUserNotificationCenter, dropping the handle posts the banner
            // asynchronously. Waiting for a response can keep a worker forever.
            match notification.show() {
                Ok(handle) => drop(handle),
                Err(error) => eprintln!("Falky could not show a desktop notification: {error}"),
            }
        })
        .await;
        false
    }
}

#[cfg(target_os = "windows")]
mod os {
    use super::*;
    use notify_rust::NotificationResponse;
    use tokio::sync::{OwnedSemaphorePermit, oneshot};

    pub(super) async fn show(notification: Notification, permit: OwnedSemaphorePermit) -> bool {
        let (activated, click) = oneshot::channel();
        // The OS may retain a notification after the banner disappears. Keep its
        // waiter off both the UI thread and the async runtime's shutdown path.
        let _ = std::thread::Builder::new()
            .name("falky-notification".into())
            .spawn(move || {
                let _permit = permit;
                match notification.show() {
                    Ok(handle) => {
                        let _ = handle.wait_for_response(move |response: &NotificationResponse| {
                            let _ = activated.send(response.is_default_action());
                        });
                    }
                    Err(error) => eprintln!("Falky could not show a desktop notification: {error}"),
                }
            });
        click.await.unwrap_or(false)
    }
}
