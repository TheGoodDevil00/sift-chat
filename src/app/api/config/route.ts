import { NextResponse } from 'next/server';
import { getPublicConfigSummary } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const summary = getPublicConfigSummary();
    return NextResponse.json(summary);
  } catch (err: any) {
    console.error('Failed to get public config summary:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve configuration status' },
      { status: 500 }
    );
  }
}
