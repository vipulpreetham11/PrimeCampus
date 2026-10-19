import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { GenerateLessonsForm } from './LessonsGenerate';
import { SectionSelect, useSectionOptions } from './pickers';

// Admin "Lessons" tool (brief §1): create/refresh dated lessons from the active timetables for a
// date range (≤ 63 days), for every section or one.

export function LessonsToolPage() {
  const { options, query } = useSectionOptions();
  const [sectionId, setSectionId] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/timetable">
          <ArrowLeft aria-hidden="true" /> Timetable
        </Link>
      </Button>
      <PageHeader
        title="Update lessons"
        description="Creates the dated lessons from the active timetables, and moves unused future lessons to the current plan. Lessons that already have attendance, diary or homework are never changed."
      />
      <DataState query={query}>
        {() => (
          <div className="space-y-4">
            <SectionSelect
              id="lessons-section"
              value={sectionId}
              onChange={setSectionId}
              options={options}
              allowAll
            />
            <GenerateLessonsForm key={sectionId ?? 'all'} sectionId={sectionId} />
          </div>
        )}
      </DataState>
    </div>
  );
}
