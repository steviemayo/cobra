'use client';
import { PageContainer } from '@/components/common/page-header';
import { PmRuns } from './pm-records';
import { PmSchedules } from './pm-schedule';

/** A room's maintenance: what is scheduled, and the record of every visit, kept with the room. */
export function RoomMaintenance({ roomId }: { roomId: string }) {
  return (
    <PageContainer className="pt-5">
      <div className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Schedule</h2>
          <PmSchedules roomId={roomId} compact />
        </section>
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Visits</h2>
          <PmRuns roomId={roomId} compact />
        </section>
      </div>
    </PageContainer>
  );
}
