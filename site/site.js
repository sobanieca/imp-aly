const STORAGE_KEY = 'imp-aly.site.scheme'
const root = document.documentElement

const labelOf = (scheme) =>
  scheme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'

const toggle = document.querySelector('.scheme')

const apply = (scheme) => {
  root.dataset.scheme = scheme
  toggle.setAttribute('aria-label', labelOf(scheme))
  try {
    localStorage.setItem(STORAGE_KEY, scheme)
  } catch {
    return
  }
}

apply(root.dataset.scheme === 'dark' ? 'dark' : 'light')
toggle.addEventListener('click', () => apply(root.dataset.scheme === 'dark' ? 'light' : 'dark'))

const selectText = (node) => {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

for (const button of document.querySelectorAll('.copy')) {
  const command = button.parentElement.querySelector('code')
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command.textContent)
    } catch {
      selectText(command)
      return
    }
    button.classList.add('is-copied')
    button.textContent = 'Copied'
    setTimeout(() => {
      button.classList.remove('is-copied')
      button.textContent = 'Copy'
    }, 1600)
  })
}
