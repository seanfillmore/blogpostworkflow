---
name: marketing-ai-broll-generation
description: Use when a talking-head short-form video or ad has no visual support behind it and you want to rebuild it with AI-generated B-roll — covers marking the script's visual beats, generating a frame per beat in an image model, animating frames in a video model, chaining end frames to start frames, and holding character consistency across a sequence.
---

# Ai Broll Generation

## Rebuild an existing talking-head winner as a second ad by keeping the script, audio and messaging identical and changing only the visuals — generate B-roll frames for each beat and cut them against the original audio — so if it wins you know the visuals carried it.

**Why it works:** Holding everything but the visuals constant makes the new asset a different creative entity with a different first frame and a different reason to stop, while also functioning as a clean single-variable test of whether visual support lifts a proven script.

**Evidence offered:** Reported as a test the agency's founders put in the calendar this month; explicitly flagged as 'the result is not in yet'.

**Fit here (7/10):** RSC already films its own talking-head short form, so there is a stock of proven scripts to rebuild, and the operator is the editor. It fits the existing rule about taking top-performing organic short form into paid, and adds a way to extend a winner's life instead of hunting a new concept. The creator's own evidence for the visual-lift claim is pending, which is what keeps this off the top of the range — not RSC's volume.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Split the tools by job: the image model makes the frames and the video model only animates them — generating frames inside the video tool is where wobbly, melting output comes from, because clip quality is decided almost entirely by the start frame you feed it.

**Why it works:** Video models are optimised for motion, not for composition or subject fidelity; feeding them an already-correct, reference-grounded start frame constrains what they can distort.

**Evidence offered:** Assertion from production experience, naming Kling and Higgsfield as the animators.

**Fit here (7/10):** A clear, cheap workflow rule for a one-person video operation — it prevents the most common waste in AI video, and the tools are consumer-priced subscriptions the solo operator can run himself. Platform-mechanics class and the tool names will churn, but the frames-then-motion split is the durable part.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Pull the script of the video you are supporting, mark its visual beats (usually eight to ten in a 40-second piece), and write a one-line scene for each in the same SCENE / SUBJECT / EMOTIONAL READ format used for statics, because each frame has the same job.

**Why it works:** Beat-marking turns an unstructured script into a fixed shot list with a named emotional job per frame, so the generation step has a specific brief per clip instead of one vague instruction for the whole video.

**Evidence offered:** Assertion from documented workflow.

**Fit here (7/10):** Direct translation to RSC's own short-form: he writes and films the scripts himself, so beat-marking one of them and generating support frames is a same-day job. Reuses the concept schema already adopted for statics, which keeps the two workflows on one format. Durable process, runnable today.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Use real photographs as generation references but prompt completely different characters from them — you keep the framing, light and physical plausibility of a real photo while changing everything a viewer would recognise.

**Why it works:** The reference supplies the physical realism the model otherwise invents badly (lighting geometry, plausible bodies and framing), while the prompt replaces the identifying features, so the output looks photographed without depicting a real person.

**Evidence offered:** Reported as a method one editor adopted from a colleague and now uses exclusively; named as what 2.5's reference preservation improves most.

**Fit here (7/10):** Lets a solo operator produce people-in-scene creative without hiring a model or appearing himself in every frame, using photos he can shoot on his own phone — and it pairs with the existing rule about keeping an enduring non-founder likeness consistent across frames. Durable technique; runnable today with no second person involved.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Chain the frames — the last frame of clip one becomes the start frame of clip two — so continuity comes free and you halve the number of generations.

**Why it works:** Each clip inherits the exact visual state of the previous one, so the world, wardrobe and lighting cannot drift between cuts, and you only generate one new frame per beat instead of a fresh start and end pair.

**Evidence offered:** Assertion from documented workflow.

**Fit here (7/10):** A concrete cost-and-time halver for the one person doing all the generation and editing himself. Durable technique that holds regardless of which image or video model is current.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Do the production in a fixed order — characters first, environments second, product last — because characters set the reference everything downstream inherits, and generating them last forces you to regenerate everything.

**Why it works:** Reference dependency runs one way: the environment is built around the character and the product is placed into the scene, so fixing the most-inherited asset first prevents cascading rework.

**Evidence offered:** Assertion from documented workflow.

**Fit here (7/10):** A sequencing rule that saves the solo operator the single largest waste in AI creative production — rework. It applies equally to a static set and a B-roll sequence, and requires nothing but discipline. Durable process claim.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Expect faces to drift across a batch — one thread holds a character well, thirty threads will not — so carry the same reference image into every thread rather than relying on the model's memory.

**Why it works:** Character consistency is a property of a single conversation's context, not of the model; re-anchoring each new thread to the same uploaded reference is what reproduces the face.

**Evidence offered:** Stated explicitly as a known limitation of the current model.

**Fit here (7/10):** A named failure mode with a named fix, which is what keeps a one-person creative batch from shipping three ads whose 'same' customer is visibly three different people. Fast-decaying platform-mechanics class, but ten days old and consistent with how these models behave generally.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*
