import type { Metadata } from 'next';
import { RoomCopy } from '@/components/pages/room-copy';

export const metadata: Metadata = { title: 'Make rooms from a shape' };

export default async function RoomsFromShapePage({
  params,
}: {
  params: Promise<{ shapeId: string }>;
}) {
  const { shapeId } = await params;
  return <RoomCopy shapeId={shapeId} />;
}
