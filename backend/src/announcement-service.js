let currentMarquee = "Welcome to Nitto 1320 Legends! | Admin God Mode Enabled.";

export function setMarquee(text) {
    currentMarquee = text;
}

export function getMarqueeXml() {
    return `<marquee>${currentMarquee}</marquee>`;
}
