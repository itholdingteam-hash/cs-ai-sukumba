export function getElement(id) {

    const element = document.getElementById(id);



    if (!element) {

        console.warn(`Elemen #${id} tidak ditemukan.`);

    }



    return element;

}



export function setText(id, value = "") {

    const element = getElement(id);



    if (element) {

        element.textContent = value;

    }

}



export function setValue(id, value = "") {

    const element = getElement(id);



    if (element) {

        element.value = value;

    }

}



export function showElement(id) {

    const element = getElement(id);



    if (element) {

        element.hidden = false;

    }

}



export function hideElement(id) {

    const element = getElement(id);



    if (element) {

        element.hidden = true;

    }

}



export function setLoading(button, loading, loadingText = "Memproses...") {

    if (!button) return;



    if (!button.dataset.originalText) {

        button.dataset.originalText = button.textContent;

    }



    button.disabled = loading;



    button.textContent = loading

        ? loadingText

        : button.dataset.originalText;

}
