const form = document.querySelector("#proxy-form");
const addressInput = document.querySelector("#destination");
const errorMessage = document.querySelector("#address-error");
const openButton = document.querySelector("#open-button");

function normalizeAddress(value) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a website address to continue.");
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let target;
  try {
    target = new URL(candidate);
  } catch {
    throw new Error("That address doesn’t look valid. Try a full domain, such as example.com.");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS websites can be opened.");
  }
  if (!target.hostname || target.username || target.password) {
    throw new Error("Enter a public website address without embedded login details.");
  }
  return target;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  errorMessage.hidden = true;
  errorMessage.textContent = "";

  try {
    const target = normalizeAddress(addressInput.value);
    openButton.disabled = true;
    openButton.querySelector("span").textContent = "Opening…";
    window.location.assign(`/api/proxy?url=${encodeURIComponent(target.href)}`);
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
    addressInput.focus();
  }
});

addressInput.addEventListener("input", () => {
  if (!errorMessage.hidden) {
    errorMessage.hidden = true;
    errorMessage.textContent = "";
  }
});
