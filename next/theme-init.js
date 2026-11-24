try {
  if (JSON.parse(localStorage.getItem("viz.theme")) === "light") {
    document.documentElement.dataset.theme = "light";
  }
} catch {}
