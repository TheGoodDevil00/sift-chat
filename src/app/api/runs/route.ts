import { NextResponse } from 'next/server';
import { runManager } from '@/lib/agent/run-manager';

export const dynamic = 'force-dynamic';

export async function GET() {
  const activeRuns = runManager.getAllActiveRuns();
  return NextResponse.json({ activeRuns });
}
