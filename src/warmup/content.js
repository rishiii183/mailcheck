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
 * 5.3 Rule: 40+ short natural business reply templates for warm-up threading
 */
export const REPLY_TEMPLATES = [
  '{Hi|Hey},\n\n{Thanks for sending this over|Got it, thanks for the update}.\n\n{Everything looks good on my end|I have reviewed and agree with the approach}.\n\n{Talk soon|Best regards}!',
  '{Hello|Hi},\n\n{Appreciate the quick follow-up|Thanks for letting me know}.\n\n{Let us proceed with the plan|Sounds like a great plan}.\n\n{Cheers|Thanks}',
  '{Hey|Hi},\n\n{Looks solid to me|No issues from my perspective}.\n\n{Let me know once the next revision is ready|Will catch up at the next sync}.\n\n{Best|Regards}',
  '{Hi|Hello},\n\n{Thanks for checking in|Good to hear from you}.\n\n{Tuesday afternoon works well for me|Wednesday morning is wide open on my calendar}.\n\n{Let us connect then|Looking forward to it}!',
  '{Hi there|Hey},\n\n{I took a quick look at the details|Just went through the shared notes}.\n\n{Everything seems completely in order|All looks clear}.\n\n{Thanks again|Cheers}',
  '{Hello|Hi},\n\n{Confirming receipt, thank you|Got your note, thanks}.\n\n{Will follow up if anything else comes up|Nothing more needed from our side for now}.\n\n{Best regards|Warmly}',
  '{Hey|Hi},\n\n{Thanks for the clarification|That clears things up nicely}.\n\n{Let us push forward with this|I will update our team accordingly}.\n\n{Have a great afternoon|Talk soon}',
  '{Hi|Hello},\n\n{Great work on getting this out so quickly|Really appreciate the fast turnaround}.\n\n{Let me review with the team and get back to you by tomorrow|Will review today}.\n\n{Best|Thanks}',
  '{Hi|Hello},\n\n{Understood, thank you|Makes total sense}.\n\n{Let me know if you need any input from my side|Happy to assist if anything arises}.\n\n{Cheers|Regards}',
  '{Hey there|Hi there},\n\n{Sounds like a good approach|Agreed on all points}.\n\n{Let us touch base early next week|Looking forward to catching up}.\n\n{Best|Take care}',
  '{Hello|Hi},\n\n{Thanks for the heads up|Good to know, thank you}.\n\n{I will keep an eye out for the next update|Noted on our end}.\n\n{Best regards|Thanks}',
  '{Hi|Hey},\n\n{Perfect, thank you|That works out nicely}.\n\n{See you at the upcoming sync|Talk to you soon}.\n\n{Cheers|Best}',
  '{Hey|Hi},\n\n{Thanks for sharing this article|Very interesting read, thanks for passing along}.\n\n{Section two had some really insightful points|Definitely relevant to what we are building}.\n\n{Talk soon|Cheers}',
  '{Hello|Hi},\n\n{Payment received and recorded on our side|Invoice matched and confirmed}.\n\n{Thanks for the prompt confirmation|Have a wonderful rest of your week}.\n\n{Sincerely|Best regards}',
  '{Hi|Hello},\n\n{The countersigned document has been archived|All paperwork is in order}.\n\n{Looking forward to kicking things off|Let us know if you need anything else}.\n\n{Best|Warmly}',
  '{Hey|Hi},\n\n{Calendar invite accepted|I have added this to my calendar}.\n\n{Looking forward to our conversation|Talk shortly}.\n\n{Cheers|Best}',
  '{Hello|Hi},\n\n{Thanks for making the intro|Nice to meet you virtually}.\n\n{Would love to set up a brief chat next week|Looking forward to connecting}.\n\n{Best regards|Thanks}',
  '{Hi|Hey},\n\n{Thanks for the feedback|I will implement those adjustments today}.\n\n{Will share the updated link as soon as ready|Thanks again for reviewing}.\n\n{Best|Cheers}',
  '{Hey|Hi},\n\n{Looks great! No further changes needed from my side|All good here}.\n\n{Good luck with the launch|Excited to see this go live}.\n\n{Best|Talk soon}',
  '{Hi|Hello},\n\n{Thanks for digging into this so thoroughly|Appreciate you looking into the details}.\n\n{I will let the rest of the team know|We are all aligned on this}.\n\n{Warm regards|Cheers}',
  '{Hey|Hi},\n\n{Got it! Thanks for flagging this early|Good catch on that}.\n\n{I will adjust the numbers right away|Updated on our spreadsheet}.\n\n{Thanks|Best}',
  '{Hello|Hi},\n\n{Checked the shared document and left a few thumbs up|Everything reads very well}.\n\n{Ready to send to the executive group|Let me know if you want one final pass}.\n\n{Best regards|Thanks}',
  '{Hi|Hello},\n\n{I can do Thursday at 2 PM if that still works|How about Friday morning instead}?\n\n{Let me know which time slot fits your schedule better|Let me know if that works for you}.\n\n{Best|Cheers}',
  '{Hey|Hi},\n\n{Thanks for running the numbers on this|The forecast looks very reasonable}.\n\n{Let us bring this up at Monday standup|Looking forward to discussing}.\n\n{Talk soon|Best}',
  '{Hi|Hello},\n\n{Confirmed from my end|Approved on our side}.\n\n{Please proceed whenever ready|Thanks for coordinating}.\n\n{Best regards|Thanks}',
  '{Hello|Hi},\n\n{Much appreciated! Have a restful weekend|Thanks, enjoy your week ahead}.\n\n{We will circle back on Monday|Talk next week}.\n\n{Cheers|Warmly}',
  '{Hi|Hey},\n\n{Thanks for the update on the migration|Good to see things progressing smoothly}.\n\n{Ping me if you encounter any unexpected roadblocks|Happy to help unblock if needed}.\n\n{Best|Regards}',
  '{Hey|Hi},\n\n{Sounds good to me|I agree with this recommendation}.\n\n{Let us take this offline and finalize over chat|Will ping you on Slack}.\n\n{Cheers|Best}',
  '{Hi|Hello},\n\n{Received with thanks|Notes received}.\n\n{Will review over lunch and send any notes before EOD|Looking over this now}.\n\n{Talk soon|Best}',
  '{Hello|Hi},\n\n{Everything is confirmed and scheduled|Room booked and link active}.\n\n{See you then|Looking forward to our chat}.\n\n{Best regards|Thanks}',
  '{Hey|Hi},\n\n{Appreciate the update on the customer inquiry|Thanks for stepping in on that}.\n\n{Customer seems satisfied with the resolution|Great job handling that}.\n\n{Cheers|Best}',
  '{Hi|Hello},\n\n{Thanks for sending over the slide deck|The new visual layout is much cleaner}.\n\n{Ready for the stakeholder review|Thanks for the extra polish}.\n\n{Best regards|Cheers}',
  '{Hello|Hi},\n\n{Got the revised figures|Everything matches our internal records now}.\n\n{Thanks for sorting that out so quickly|Have a great day}.\n\n{Sincerely|Best}',
  '{Hey|Hi},\n\n{Thanks for the heads-up on the schedule change|No problem at all on my end}.\n\n{Rescheduled on my calendar as well|See you then}.\n\n{Best|Cheers}',
  '{Hi|Hello},\n\n{Just checked the staging environment|The new release candidate is performing well}.\n\n{Green light from QA to proceed to production|Great work all}.\n\n{Best regards|Thanks}',
  '{Hey|Hi},\n\n{Thanks for reaching out! Looking forward to collaborating on this|Glad we connected}.\n\n{Will draft a shared outline for us to work from|Talk soon}.\n\n{Cheers|Best}',
  '{Hello|Hi},\n\n{Thanks for the clarification on the milestone dates|Everything aligns with our roadmap}.\n\n{Keep us posted if anything shifts|Thanks for your diligence}.\n\n{Warm regards|Best}',
  '{Hi|Hey},\n\n{Received! I will take ownership of this task|On it right away}.\n\n{Will send a confirmation once complete|Talk soon}.\n\n{Best|Thanks}',
  '{Hey|Hi},\n\n{Looks complete and accurate|No gaps found}.\n\n{Ready for the auditor sign-off|Thanks for getting this compiled}.\n\n{Cheers|Best regards}',
  '{Hi|Hello},\n\n{Thanks for following up on this thread|Good to have closure on this topic}.\n\n{Archiving on our side as well|Have a good one}!\n\n{Best|Thanks}',
  '{Hello|Hi},\n\n{The feedback has been incorporated into the master copy|Draft is finalized}.\n\n{Thanks to everyone for the input|Talk soon}.\n\n{Best regards|Cheers}',
  '{Hey|Hi},\n\n{All set! Let us know if you need any follow-up data|Ready when you are}.\n\n{Have a great rest of your day|Cheers}.\n\n{Best|Thanks}'
];

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

/**
 * 5.3 Rule: Returns a rendered random short business reply template
 * @returns {{ body: string }}
 */
export function getRandomReplyTemplate() {
  const pick = REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)];
  return {
    body: renderSpintax(pick)
  };
}

export const getRandomTemplate = getRandomWarmupTemplate;
export const WARMUP_TEMPLATES = BASE_TEMPLATES;
