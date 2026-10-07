const HOME_PAGE = '/'

const parentOf = (page, pages) =>
  pages.filter((other) => other !== HOME_PAGE && other !== page && page.startsWith(`${other}/`))
    .sort((a, b) => b.length - a.length)[0]

export const pageTree = (list) => {
  const pages = [...new Set(list)].sort()
  const nodes = new Map(pages.map((page) => [page, { value: page, label: page, children: [] }]))
  const roots = []
  for (const page of pages) {
    const parent = parentOf(page, pages)
    if (parent) nodes.get(parent).children.push(nodes.get(page))
    else roots.push(nodes.get(page))
  }
  const clean = (node) =>
    node.children.length
      ? { ...node, children: node.children.map(clean) }
      : { value: node.value, label: node.label }
  return roots.map(clean)
}
