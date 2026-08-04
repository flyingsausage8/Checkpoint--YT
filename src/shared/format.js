(() => {
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number.isFinite(Number(seconds)) ? Number(seconds) : 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = String(total % 60).padStart(2, '0');
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${rest}`;
    return `${minutes}:${rest}`;
  }

  window.FocusFlowFormat = { formatTime };
})();
