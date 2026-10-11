---
tags: [moc, "project/active"]
aliases:
  - Start Here
  - Dashboard
status: active
rating: 5
created: 2024-01-10
---
# Welcome to the vault

This is the **home** note. It links to [[Alpha]], to [[Projects/Alpha|the alpha project]] and to [[Renamed by frontmatter]].

## Links of every kind
- Heading link: [[Beta#Section Two]]
- Block link: [[Beta#^key-point]]
- Missing block: [[Beta#^nope]]
- Unresolved: [[Missing Note]]
- Daily note: [[2024-01-15]]
- Markdown link to a note: [Deep note](Projects/Sub/Deep.md)
- Alias link: [[Start Here]]
- Same-note heading: [[#Links of every kind]]
- Ambiguous name: [[Meeting]]

## Embeds
![[Beta]]
![[diagram.png]]
![Holiday photo](attachments/photo%20one.jpg)
![[report.pdf]]
![[missing-image.png]]

## Tasks and tags
- [ ] Write the import PRD #todo
- [x] Build the attachment store #nested/tag
  - [ ] A nested task

> [!warning] Mind the gap
> Callouts become quotes with the type in bold.

> [!tip]- Folded tip
> Still a quote.

Text with a %%hidden comment%% inside.

%%
A multi-line comment
%%

Inline math $e^{i\pi} + 1 = 0$ and a block:

$$
\int_0^1 x\,dx
$$

```dataview
LIST FROM #moc
```

```tasks
not done
```

```python
print("[[not a link]]")
```

| Col A | Col B |
|-------|-------|
| 1     | 2     |
