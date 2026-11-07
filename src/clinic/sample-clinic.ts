import type { Clinic } from "./clinic.js";

/** Fictional clinic used for the demo. Names, prices and answers are sample data. */
export function sampleClinic(timeZone: string): Clinic {
  return {
    name: "Maple Dental (sample clinic)",
    address: "12 Example Street, Demo City",
    timeZone,
    slotMinutes: 30,
    maxDaysAhead: 30,
    minNoticeMinutes: 60,
    maxActiveBookingsPerPatient: 2,
    openingHours: {
      1: { open: "09:00", close: "18:00" },
      2: { open: "09:00", close: "18:00" },
      3: { open: "09:00", close: "18:00" },
      4: { open: "09:00", close: "18:00" },
      5: { open: "09:00", close: "16:00" },
      6: { open: "10:00", close: "14:00" },
    },
    services: [
      { id: "checkup", name: "Check-up and cleaning", durationMinutes: 30, priceLabel: "€60" },
      { id: "whitening", name: "Teeth whitening", durationMinutes: 60, priceLabel: "€180" },
      { id: "filling", name: "Filling", durationMinutes: 60, priceLabel: "from €90" },
      { id: "consultation", name: "Consultation", durationMinutes: 30, priceLabel: "€30" },
    ],
    faq: [
      {
        id: "hours",
        question: "What are your opening hours?",
        answer: "Mon–Thu 09:00–18:00, Fri 09:00–16:00, Sat 10:00–14:00. Closed on Sundays.",
        keywords: ["hours", "open", "opening", "close", "closing", "sunday", "saturday", "weekend", "time"],
      },
      {
        id: "location",
        question: "Where are you located?",
        answer: "12 Example Street, Demo City. The entrance is from the courtyard, second floor with a lift.",
        keywords: ["where", "address", "location", "located", "find", "directions", "lift", "floor"],
      },
      {
        id: "parking",
        question: "Is there parking?",
        answer: "There is free street parking for 2 hours and a paid garage 100 m away.",
        keywords: ["parking", "park", "car", "garage"],
      },
      {
        id: "payment",
        question: "How can I pay?",
        answer: "Card or cash at the reception after the visit. We do not take payment over WhatsApp.",
        keywords: ["pay", "payment", "card", "cash", "price", "cost"],
      },
      {
        id: "insurance",
        question: "Do you accept insurance?",
        answer: "We give you an itemised invoice you can send to your insurer. We do not bill insurers directly.",
        keywords: ["insurance", "insurer", "invoice", "reimburse", "claim"],
      },
      {
        id: "cancellation",
        question: "What is the cancellation policy?",
        answer: "Please cancel at least 24 hours before your visit. You can cancel right here in this chat.",
        keywords: ["cancel", "cancellation", "reschedule", "late", "policy", "change"],
      },
      {
        id: "emergency",
        question: "I have a dental emergency",
        answer: "For severe pain, swelling or bleeding call the emergency number of your country. Same-day slots are offered when available.",
        keywords: ["emergency", "pain", "urgent", "bleeding", "swelling", "hurts", "toothache"],
      },
    ],
  };
}
