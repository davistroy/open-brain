// Phase 15.4 — Entity detail page (stub)
import { useParams } from 'react-router-dom';

export default function EntityDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Entity Detail</h1>
      <p className="text-muted-foreground">Entity {id} — full detail coming in Phase 15.4</p>
    </div>
  );
}
