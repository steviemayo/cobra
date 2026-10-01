import type { Metadata } from 'next';
import { RoomShapes } from '@/components/pages/room-shapes';

export const metadata: Metadata = { title: 'Room shapes' };

export default function RoomShapesPage() {
  return <RoomShapes />;
}
