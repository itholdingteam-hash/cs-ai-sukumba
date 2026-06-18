const TOAST_DURATION = 3000;

export function showToast(
    message,
    type = "success"
) {
    const toast = document.createElement("div");

    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", "status");

    const indicator = document.createElement("span");
    indicator.className = "toast-indicator";

    const text = document.createElement("span");
    text.textContent = message;

    toast.append(indicator, text);
    document.body.appendChild(toast);

    window.setTimeout(() => {
        toast.remove();
    }, TOAST_DURATION);
}
