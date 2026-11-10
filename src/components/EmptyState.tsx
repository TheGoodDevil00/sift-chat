'use client';

import React from 'react';

interface EmptyStateProps {
  onSelectPrompt: (prompt: string) => void;
}

const SAMPLE_PROMPTS = [
  'What did we decide last week?',
  'Check whether the tools we shortlisted have changed pricing.',
  'Is the recommendation you gave me last month still current?',
  'Compare Postgres hosting options and check for any recent price changes.',
];

export function EmptyState({ onSelectPrompt }: EmptyStateProps) {
  return (
    <div className="max-w-3xl mx-auto my-12 p-6 text-center border-2 border-dashed border-gray-300 rounded-lg bg-white/70">
      <div className="inline-block p-2 bg-orange-100 text-orange-700 font-bold rounded text-xs uppercase tracking-widest mb-3">
        Temporal Research Assistant
      </div>
      <h2 className="text-2xl font-bold mb-2">Sift remembers, verifies, and cites.</h2>
      <p className="text-gray-600 mb-6 text-sm max-w-xl mx-auto">
        Ask about past conversations, verify if prior recommendations remain accurate, or
        check whether software tools have changed pricing or shipped new releases.
      </p>

      <div className="text-left max-w-xl mx-auto">
        <div className="text-xs font-semibold uppercase text-gray-500 mb-2">
          Suggested queries:
        </div>
        <div className="flex flex-col gap-2">
          {SAMPLE_PROMPTS.map((prompt, idx) => (
            <button
              key={idx}
              onClick={() => onSelectPrompt(prompt)}
              className="text-left p-3 text-xs md:text-sm border border-gray-300 rounded-md hover:border-orange-500 hover:bg-orange-50/50 transition-all font-mono text-gray-800 cursor-pointer flex items-center justify-between group"
            >
              <span>{prompt}</span>
              <span className="text-orange-500 font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                →
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
