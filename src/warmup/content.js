import { renderSpintax } from '../campaigns/render.js';

/**
 * 20+ base topics with combinatorial spintax variations generating >200 distinct,
 * natural, professional business exchanges.
 */
const BASE_TEMPLATES = [
  {
    subject: '{Quick question|Quick sync|Following up} regarding {the presentation|the project timeline|our call yesterday}',
    body: '{Hi|Hello|Hey},\n\n{Just wanted to check if you had a moment to review|Checking in on|Did you have a chance to look at} {the updated draft|the latest slide deck|the notes we discussed}?\n\n{Let me know if anything needs adjusting|Looking forward to your thoughts|Talk soon}.\n\n{Best|Thanks|Regards},\n{Alex|Sam|Chris}'
  },
  {
    subject: '{Coffee next week|Catching up next week|Lunch sync}?',
    body: '{Hey|Hi},\n\n{Are you going to be around the office next Tuesday or Wednesday|It has been a while since we caught up|Do you have any free time next week}?\n\n{Would love to grab a coffee and hear how things are going|Let me know if your schedule allows for a quick chat}.\n\n{Cheers|Best},\n{Taylor|Jordan|Morgan}'
  },
  {
    subject: '{Feedback on|Thoughts on} {the Q3 roadmap|the new design layout|the proposal}',
    body: '{Hello|Hi|Good morning},\n\n{I went through the latest updates and everything looks solid|Thanks for putting this together, really great work|Overall the direction looks great}.\n\n{One small suggestion on slide 4: should we add the customer quotes|I left a couple of inline comments in the shared doc|Let me know when the final version is ready}.\n\n{Best regards|Thanks|Cheers},\n{Casey|Pat|Robin}'
  },
  {
    subject: '{Invoice receipt|Receipt confirmation|Payment confirmation} - #{1042|2085|3190}',
    body: '{Hi|Hello},\n\n{Confirming that we received your invoice|This is to confirm that the payment has been processed|Just sent over the remittance details for your records}.\n\n{Let me know if you need anything else on our end|Thanks for your prompt assistance}.\n\n{Sincerely|Best regards},\n{Accounting Team|Finance Dept}'
  },
  {
    subject: '{Updated meeting link|Rescheduled meeting link|New link for our call}',
    body: '{Hi everyone|Hi team|Hey},\n\n{Here is the updated conference link for our session later today|Please use this new link for our upcoming sync|Moving our call to this room}:\n\nhttps://meet.example.com/{sync-room|team-room|update-call}\n\n{See you shortly|Looking forward to connecting}.\n\n{Best|Thanks},\n{Jamie|Lee|Quinn}'
  },
  {
    subject: '{Introductions|Connecting you with|Quick intro}: {Dave|Sarah|Michael} & {Elena|Brian|Rachel}',
    body: '{Hi both|Hello you two},\n\n{Wanted to connect the two of you following our conversation earlier|I think you two would have a lot of common ground to discuss}.\n\n{I will let you take it from here!|Feel free to connect directly}.\n\n{Best regards|Best},\n{Terry|Drew|Avery}'
  },
  {
    subject: '{Quarterly report review|FY review summary|Monthly numbers}',
    body: '{Hi team|Hello},\n\n{Attached is the summary from this past month|Sharing the consolidated stats for your team}.\n\n{Take a look when you have a moment and let me know if you see any anomalies|We can discuss the details during Monday\'s sync}.\n\n{Thanks|Warmly},\n{Devon|Logan|Hayden}'
  },
  {
    subject: '{Contract review|NDA signed copy|Agreement status}',
    body: '{Hi|Hello},\n\n{Our legal team finished reviewing the agreement|Here is the countersigned copy of the NDA}.\n\n{All set on our side to kick off next week|Let me know if your team needs any further documentation}.\n\n{Best regards|Thanks},\n{Kendall|Peyton|Skyler}'
  },
  {
    subject: '{Great speaking with you|Thanks for your time|Good chatting earlier}',
    body: '{Hi|Hey},\n\n{Really enjoyed our conversation earlier today|Thank you for taking the time to share your insights}.\n\n{Let\'s reconnect in a couple of weeks once we have the prototype ready|I will send over the extra links we talked about tomorrow}.\n\n{Have a great rest of your week|Talk soon}!\n\n{Best|Cheers},\n{Reese|Cameron|Rowan}'
  },
  {
    subject: '{Resource recommendation|Interesting article|Relevant case study}',
    body: '{Hey|Hi},\n\n{Ran across this article this morning and immediately thought of our discussion|Thought you might find this case study interesting}:\n\nhttps://example.com/insights/{growth-trends|scaling-systems|product-architecture}\n\n{Curious to hear your take on section 3|Let me know what you think}.\n\n{Best|Cheers},\n{Finley|Dakota|Emerson}'
  }
];

// Generate 200+ distinct variations dynamically from combinatorial patterns
const TOPICS = [
  'budget review', 'marketing brief', 'API migration', 'server maintenance', 'team offsite',
  'vendor onboarding', 'dashboard wireframes', 'security audit', 'product demo', 'press release',
  'client onboarding', 'feature release', 'documentation update', 'interview feedback', 'office relocation',
  'sales deck', 'conference passes', 'feedback request', 'user testing notes', 'weekly standup',
  'contract renewal', 'customer survey', 'quarterly forecast', 'infrastructure plan', 'incident review',
  'design review', 'content calendar', 'support escalations', 'partner sync', 'database tuning',
  'billing verification', 'recruiting targets', 'lead routing', 'retrospective action items', 'SOC2 compliance',
  'architecture blueprint', 'release candidates', 'pricing matrix', 'ad campaign stats', 'all-hands presentation'
];

const VARIANT_PATTERNS = [
  { subj: '{Quick question|Question|Quick check} on {the|our}', act: '{Can you give me a quick status update on|Just checking in to see where we stand with|Any news on}' },
  { subj: '{Update regarding|Status update for|Latest notes on}', act: '{Sending over the latest progress report on|Here is where we currently stand with|Touching base on the current state of}' },
  { subj: '{Thoughts on|Reviewing|Feedback needed on}', act: '{Could you take a quick look when free at|Sharing the latest draft concerning|Would love your feedback on}' },
  { subj: '{Upcoming deadlines for|Schedule and timeline on|Milestones for}', act: '{Looking ahead at the upcoming delivery schedule for|Making sure we remain on schedule with|Wanted to align on milestones for}' },
  { subj: '{Follow up on|Checking in regarding|Sync on}', act: '{Following up on our discussion regarding|Circling back to touch base on|Wanted to see if you had any updates on}' }
];

for (const topic of TOPICS) {
  for (const pattern of VARIANT_PATTERNS) {
    BASE_TEMPLATES.push({
      subject: `${pattern.subj} ${topic}`,
      body: `{Hi|Hello|Hey},\n\n${pattern.act} the ${topic}. {Everything seems to be tracking nicely|Let me know if there are any questions or blockers|Happy to jump on a quick call if helpful}.\n\n{Talk soon|Have a great day|Best regards},\n{Alex|Jordan|Taylor|Sam}`
    });
  }
}

/**
 * Returns a rendered random business warm-up template
 * @returns {{ subject: string, body: string }}
 */
export function getRandomWarmupTemplate() {
  const pick = BASE_TEMPLATES[Math.floor(Math.random() * BASE_TEMPLATES.length)];
  return {
    subject: renderSpintax(pick.subject),
    body: renderSpintax(pick.body)
  };
}

export const getRandomTemplate = getRandomWarmupTemplate;
export const WARMUP_TEMPLATES = BASE_TEMPLATES;

/**
 * Optional hook to generate fresh text via LLM API if configured in .env
 */
export async function generateFreshWarmupText(apiKey = process.env.LLM_API_KEY) {
  if (!apiKey) {
    return getRandomWarmupTemplate();
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are writing a short, authentic 2-3 sentence business email between professional colleagues about a casual work topic. Return JSON: { "subject": "...", "body": "..." }' },
          { role: 'user', content: 'Generate a short casual business message.' }
        ],
        response_format: { type: 'json_object' }
      })
    });

    if (res.ok) {
      const json = await res.json();
      const content = JSON.parse(json.choices[0].message.content);
      return {
        subject: content.subject,
        body: content.body
      };
    }
  } catch (err) {
    // Fallback to local template
  }

  return getRandomWarmupTemplate();
}
