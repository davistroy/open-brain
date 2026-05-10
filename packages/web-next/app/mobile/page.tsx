import { MobileShell } from '@/components/mobile/MobileShell'

interface Props {
  searchParams: Promise<{ q?: string }>
}

export default async function MobilePage({ searchParams }: Props) {
  const { q = '' } = await searchParams
  return <MobileShell initialQuery={q.trim()} />
}
