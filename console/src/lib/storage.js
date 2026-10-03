export const readStored = (key, fallback) => {
  try {
    const text = localStorage.getItem(key)
    return text === null ? fallback : JSON.parse(text)
  } catch {
    return fallback
  }
}

export const writeStored = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}
