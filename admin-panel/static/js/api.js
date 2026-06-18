(function () {
async function request(
    url,
    options = {}
) {
    const config = {
        ...options,
        headers: {
            Accept: "application/json",
            ...(options.headers || {}),
        },
    };

    if (
        config.body &&
        typeof config.body === "object" &&
        !(config.body instanceof FormData)
    ) {
        config.headers["Content-Type"] =
            "application/json";

        config.body =
            JSON.stringify(config.body);
    }

    let response;

    try {
        response = await fetch(
            url,
            config
        );
    } catch {
        throw new Error(
            "Tidak dapat terhubung ke server."
        );
    }

    let data = null;

    try {
        data = await response.json();
    } catch {
        data = null;
    }

    if (!response.ok) {
        const error = new Error(
            data?.message ||
            data?.error ||
            `Request gagal: ${response.status}`
        );

        error.status = response.status;
        error.data = data;

        throw error;
    }

    return data;
}

window.api = {
    get(url) {
        return request(url);
    },

    post(url, body) {
        const options = {
            method: "POST",
        };

        if (body !== undefined) {
            options.body = body;
        }

        return request(
            url,
            options
        );
    },

    put(url, body) {
        return request(url, {
            method: "PUT",
            body,
        });
    },

    delete(url) {
        return request(url, {
            method: "DELETE",
        });
    },
};
})();
