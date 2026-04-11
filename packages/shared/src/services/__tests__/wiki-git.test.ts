import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WikiGitService, parseFrontmatter, serializeFrontmatter, type WikiFrontmatter } from '../wiki-git.js'

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// Mock simple-git
const mockGit = {
  clone: vi.fn().mockResolvedValue(undefined),
  pull: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue({ summary: { changes: 1 } }),
  push: vi.fn().mockResolvedValue(undefined),
  log: vi.fn().mockResolvedValue({
    all: [
      {
        hash: 'abc123',
        date: '2026-04-11',
        message: 'Updated entities/kubernetes.md',
        diff: { files: [{ file: 'entities/kubernetes.md' }] },
      },
      {
        hash: 'def456',
        date: '2026-04-10',
        message: 'Created concepts/rag.md',
        diff: { files: [{ file: 'concepts/rag.md' }] },
      },
    ],
  }),
}

vi.mock('simple-git', () => ({
  simpleGit: vi.fn().mockImplementation(() => mockGit),
}))

// Mock fs modules
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}))

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { simpleGit } from 'simple-git'

// ---------------------------------------------------------------------------
// parseFrontmatter tests
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses basic frontmatter with all required fields', () => {
    const raw = `---
title: Kubernetes
type: entity
created: 2026-04-11
updated: 2026-04-11
---

# Kubernetes

Some content here.`

    const result = parseFrontmatter(raw)

    expect(result.frontmatter.title).toBe('Kubernetes')
    expect(result.frontmatter.type).toBe('entity')
    expect(result.frontmatter.created).toBe('2026-04-11')
    expect(result.frontmatter.updated).toBe('2026-04-11')
    expect(result.content).toBe('\n# Kubernetes\n\nSome content here.')
  })

  it('parses frontmatter with optional fields', () => {
    const raw = `---
title: Docker Compose
type: concept
created: 2026-04-11
updated: 2026-04-11
source_count: 5
tags:
  - infrastructure
  - containers
aliases:
  - docker-compose
  - compose
---

Content.`

    const result = parseFrontmatter(raw)

    expect(result.frontmatter.source_count).toBe(5)
    expect(result.frontmatter.tags).toEqual(['infrastructure', 'containers'])
    expect(result.frontmatter.aliases).toEqual(['docker-compose', 'compose'])
  })

  it('parses inline array syntax', () => {
    const raw = `---
title: Test
type: entity
created: 2026-04-11
updated: 2026-04-11
tags: [alpha, beta, gamma]
---

Body.`

    const result = parseFrontmatter(raw)
    expect(result.frontmatter.tags).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('returns defaults when no frontmatter is present', () => {
    const raw = '# Just a heading\n\nNo frontmatter here.'

    const result = parseFrontmatter(raw)

    expect(result.frontmatter.title).toBe('')
    expect(result.frontmatter.type).toBe('overview')
    expect(result.content).toBe(raw)
  })

  it('handles quoted values', () => {
    const raw = `---
title: "A page with: colons"
type: entity
created: 2026-04-11
updated: 2026-04-11
---

Content.`

    const result = parseFrontmatter(raw)
    expect(result.frontmatter.title).toBe('A page with: colons')
  })

  it('preserves extra fields beyond the standard set', () => {
    const raw = `---
title: Test
type: entity
created: 2026-04-11
updated: 2026-04-11
status: draft
confidence: high
---

Content.`

    const result = parseFrontmatter(raw)
    expect(result.frontmatter.status).toBe('draft')
    expect(result.frontmatter.confidence).toBe('high')
  })

  it('handles empty content after frontmatter', () => {
    const raw = `---
title: Empty
type: overview
created: 2026-04-11
updated: 2026-04-11
---
`

    const result = parseFrontmatter(raw)
    expect(result.frontmatter.title).toBe('Empty')
    expect(result.content).toBe('')
  })
})

// ---------------------------------------------------------------------------
// serializeFrontmatter tests
// ---------------------------------------------------------------------------

describe('serializeFrontmatter', () => {
  it('serializes frontmatter with scalar values', () => {
    const fm: WikiFrontmatter = {
      title: 'Kubernetes',
      type: 'entity',
      created: '2026-04-11',
      updated: '2026-04-11',
    }

    const result = serializeFrontmatter(fm, '# Kubernetes\n\nContent.')

    expect(result).toContain('title: Kubernetes')
    expect(result).toContain('type: entity')
    expect(result).toContain('created: 2026-04-11')
    expect(result).toContain('updated: 2026-04-11')
    // Starts with opening delimiter
    expect(result.startsWith('---\n')).toBe(true)
    // Ends with the body content
    expect(result).toContain('# Kubernetes\n\nContent.')
  })

  it('serializes array values with YAML list syntax', () => {
    const fm: WikiFrontmatter = {
      title: 'Test',
      type: 'concept',
      created: '2026-04-11',
      updated: '2026-04-11',
      tags: ['alpha', 'beta'],
    }

    const result = serializeFrontmatter(fm, 'Content.')

    expect(result).toContain('tags:\n  - alpha\n  - beta\n')
  })

  it('omits undefined and null values', () => {
    const fm: WikiFrontmatter = {
      title: 'Test',
      type: 'entity',
      created: '2026-04-11',
      updated: '2026-04-11',
      source_count: undefined as unknown as number,
    }

    const result = serializeFrontmatter(fm, 'Content.')
    expect(result).not.toContain('source_count')
  })

  it('omits empty arrays', () => {
    const fm: WikiFrontmatter = {
      title: 'Test',
      type: 'entity',
      created: '2026-04-11',
      updated: '2026-04-11',
      tags: [],
    }

    const result = serializeFrontmatter(fm, 'Content.')
    expect(result).not.toContain('tags')
  })

  it('round-trips through parse and serialize', () => {
    const original: WikiFrontmatter = {
      title: 'Round Trip',
      type: 'synthesis',
      created: '2026-04-11',
      updated: '2026-04-11',
      source_count: 3,
      tags: ['test', 'round-trip'],
    }
    const content = '# Round Trip\n\nSome content.'

    const serialized = serializeFrontmatter(original, content)
    const parsed = parseFrontmatter(serialized)

    expect(parsed.frontmatter.title).toBe(original.title)
    expect(parsed.frontmatter.type).toBe(original.type)
    expect(parsed.frontmatter.created).toBe(original.created)
    expect(parsed.frontmatter.source_count).toBe(original.source_count)
    expect(parsed.frontmatter.tags).toEqual(original.tags)
    expect(parsed.content).toBe(content)
  })
})

// ---------------------------------------------------------------------------
// WikiGitService tests
// ---------------------------------------------------------------------------

describe('WikiGitService', () => {
  let service: WikiGitService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new WikiGitService({
      repoUrl: 'git@gitea.k4jda.net:davistroy/open-brain-wiki.git',
      localPath: '/tmp/test-wiki',
    })
  })

  describe('init()', () => {
    it('clones when local path does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false)

      await service.init()

      expect(mkdir).toHaveBeenCalledWith('/tmp/test-wiki', { recursive: true })
      expect(mockGit.clone).toHaveBeenCalledWith(
        'git@gitea.k4jda.net:davistroy/open-brain-wiki.git',
        '/tmp/test-wiki',
      )
    })

    it('pulls when local path already has a .git directory', async () => {
      vi.mocked(existsSync).mockReturnValue(true)

      await service.init()

      expect(mockGit.pull).toHaveBeenCalledWith('origin', 'main')
      expect(mockGit.clone).not.toHaveBeenCalled()
    })
  })

  describe('readPage()', () => {
    it('reads and parses a wiki page', async () => {
      // Initialize first
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      vi.mocked(readFile).mockResolvedValue(`---
title: Kubernetes
type: entity
created: 2026-04-11
updated: 2026-04-11
---

# Kubernetes

Content about K8s.`)

      const page = await service.readPage('entities/kubernetes.md')

      expect(page).not.toBeNull()
      expect(page!.path).toBe('entities/kubernetes.md')
      expect(page!.frontmatter.title).toBe('Kubernetes')
      expect(page!.frontmatter.type).toBe('entity')
      expect(page!.content).toContain('Content about K8s.')
    })

    it('returns null for non-existent pages', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      vi.mocked(readFile).mockRejectedValue(err)

      const page = await service.readPage('entities/missing.md')
      expect(page).toBeNull()
    })

    it('propagates non-ENOENT errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      vi.mocked(readFile).mockRejectedValue(new Error('Permission denied'))

      await expect(service.readPage('entities/forbidden.md')).rejects.toThrow('Permission denied')
    })
  })

  describe('writePage()', () => {
    it('writes file with frontmatter, commits, and pushes', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      const fm: WikiFrontmatter = {
        title: 'New Page',
        type: 'entity',
        created: '2026-04-11',
        updated: '2026-04-11',
      }

      await service.writePage('entities/new-page.md', '# New Page\n\nContent.', fm, 'Add new page')

      // Should have written file
      expect(writeFile).toHaveBeenCalledTimes(1)
      const writtenContent = vi.mocked(writeFile).mock.calls[0][1] as string
      expect(writtenContent).toContain('title: New Page')
      expect(writtenContent).toContain('type: entity')
      expect(writtenContent).toContain('# New Page\n\nContent.')

      // Should have committed and pushed
      expect(mockGit.add).toHaveBeenCalledWith('entities/new-page.md')
      expect(mockGit.commit).toHaveBeenCalledWith('Add new page', 'entities/new-page.md')
      expect(mockGit.push).toHaveBeenCalledWith('origin', 'main')
    })

    it('auto-sets updated date to today', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      const fm: WikiFrontmatter = {
        title: 'Test',
        type: 'entity',
        created: '2026-04-01',
        updated: '2026-04-01',
      }

      await service.writePage('entities/test.md', 'Content.', fm, 'Update')

      const writtenContent = vi.mocked(writeFile).mock.calls[0][1] as string
      // updated should be today, not the original value
      const todayStr = new Date().toISOString().slice(0, 10)
      expect(writtenContent).toContain(`updated: ${todayStr}`)
    })

    it('throws if not initialized', async () => {
      const fm: WikiFrontmatter = {
        title: 'Test',
        type: 'entity',
        created: '2026-04-11',
        updated: '2026-04-11',
      }

      await expect(
        service.writePage('entities/test.md', 'Content.', fm, 'Test'),
      ).rejects.toThrow('WikiGitService not initialized')
    })
  })

  describe('listPages()', () => {
    it('walks directory and returns frontmatter for .md files', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      // Mock readdir to return files
      vi.mocked(readdir).mockImplementation(async (dir) => {
        const dirStr = String(dir)
        if (dirStr === '/tmp/test-wiki') {
          return [
            { name: 'index.md', isDirectory: () => false },
            { name: 'entities', isDirectory: () => true },
            { name: '.git', isDirectory: () => true },
          ] as any
        }
        if (dirStr.endsWith('entities')) {
          return [
            { name: 'kubernetes.md', isDirectory: () => false },
            { name: 'docker.md', isDirectory: () => false },
          ] as any
        }
        return []
      })

      vi.mocked(readFile).mockImplementation(async (path) => {
        const pathStr = String(path)
        if (pathStr.includes('index.md')) {
          return `---\ntitle: Index\ntype: overview\ncreated: 2026-04-11\nupdated: 2026-04-11\n---\nContent`
        }
        if (pathStr.includes('kubernetes.md')) {
          return `---\ntitle: Kubernetes\ntype: entity\ncreated: 2026-04-11\nupdated: 2026-04-11\n---\nK8s content`
        }
        if (pathStr.includes('docker.md')) {
          return `---\ntitle: Docker\ntype: entity\ncreated: 2026-04-11\nupdated: 2026-04-11\n---\nDocker content`
        }
        throw new Error('unexpected file: ' + pathStr)
      })

      const pages = await service.listPages()

      expect(pages.length).toBe(3)
      const titles = pages.map((p) => p.frontmatter.title)
      expect(titles).toContain('Index')
      expect(titles).toContain('Kubernetes')
      expect(titles).toContain('Docker')
      // content should NOT be included
      expect((pages[0] as any).content).toBeUndefined()
    })

    it('filters by directory when specified', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      vi.mocked(readdir).mockResolvedValue([
        { name: 'kubernetes.md', isDirectory: () => false },
      ] as any)

      vi.mocked(readFile).mockResolvedValue(
        `---\ntitle: Kubernetes\ntype: entity\ncreated: 2026-04-11\nupdated: 2026-04-11\n---\nContent`,
      )

      const pages = await service.listPages('entities')

      expect(pages.length).toBe(1)
      expect(pages[0].frontmatter.title).toBe('Kubernetes')
    })
  })

  describe('getRecentChanges()', () => {
    it('returns parsed git log entries', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      const changes = await service.getRecentChanges(10)

      expect(changes).toHaveLength(2)
      expect(changes[0].hash).toBe('abc123')
      expect(changes[0].message).toBe('Updated entities/kubernetes.md')
      expect(changes[0].files).toEqual(['entities/kubernetes.md'])
      expect(changes[1].hash).toBe('def456')

      expect(mockGit.log).toHaveBeenCalledWith({
        maxCount: 10,
        '--stat': null,
      })
    })

    it('uses default limit of 20', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      await service.getRecentChanges()

      expect(mockGit.log).toHaveBeenCalledWith({
        maxCount: 20,
        '--stat': null,
      })
    })

    it('throws if not initialized', async () => {
      await expect(service.getRecentChanges()).rejects.toThrow(
        'WikiGitService not initialized',
      )
    })
  })

  describe('commitAndPush()', () => {
    it('stages all, commits, and pushes', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      await service.commitAndPush('Batch update')

      expect(mockGit.add).toHaveBeenCalledWith('.')
      expect(mockGit.commit).toHaveBeenCalledWith('Batch update')
      expect(mockGit.push).toHaveBeenCalledWith('origin', 'main')
    })

    it('skips push when there are no changes', async () => {
      vi.mocked(existsSync).mockReturnValue(true)
      await service.init()

      mockGit.commit.mockResolvedValueOnce({ summary: { changes: 0 } })

      await service.commitAndPush('Nothing changed')

      expect(mockGit.push).not.toHaveBeenCalled()
    })

    it('throws if not initialized', async () => {
      await expect(service.commitAndPush('Test')).rejects.toThrow(
        'WikiGitService not initialized',
      )
    })
  })
})
