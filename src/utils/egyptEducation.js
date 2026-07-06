'use strict';

/**
 * Egyptian K-12 education reference data — the Cairo flavor.
 *
 * Kept as code (mirroring src/utils/governorates.js) so adding/dropping a row
 * is a one-line change with no migration. Boot seeds these into the additive
 * reference tables `directorates`, `education_stages`, `subjects`,
 * `school_terms` (all idempotent `INSERT OR IGNORE`).
 *
 * Sources cross-checked: Egyptian Ministry of Education public curriculum
 * summaries, Wikipedia EN/AR (Education_in_Egypt), and the canonical stage /
 * term vocabulary used in Egyptian schools. The set below is the well-known,
 * cairo-anchored baseline — refine as needed; none of the live service SQL
 * queries these tables, so changes here cannot break the API surface.
 */

// ── Cairo educational directorates (الإدارات التعليمية بمحافظة القاهرة) ──
// The unit between governorate and individual school. Cairo's compass-style
// four directorates are the universally recognized baseline; Helwan has its
// own directorate as well. The free-form `admin_zone` text column on staff /
// students / schools carries the Arabic directorate name.
const DIRECTORATES = Object.freeze([
  { code: 'CAI-N', gov_code: '01', name_ar: 'شمال القاهرة' },
  { code: 'CAI-E', gov_code: '01', name_ar: 'شرق القاهرة' },
  { code: 'CAI-W', gov_code: '01', name_ar: 'غرب القاهرة' },
  { code: 'CAI-S', gov_code: '01', name_ar: 'جنوب القاهرة' },
  { code: 'CAI-H', gov_code: '01', name_ar: 'حلون' },
]);

// ── Education stages (المراحل الدراسية) ──
// The existing `grade_level INTEGER (1..12)` on `students` stays untouched;
// this is just the public stage name lookup. The Ministry also has رياض
// الأطفال (KG) covering ~age 4-5, but our `grade_level` axis starts at 1.
const EDUCATION_STAGES = Object.freeze([
  { code: 'P',  name_ar: 'الابتدائية', grade_from: 1,  grade_to: 6,  ordinal: 1 },
  { code: 'PR', name_ar: 'الإعدادية',  grade_from: 7,  grade_to: 9,  ordinal: 2 },
  { code: 'S',  name_ar: 'الثانوية',   grade_from: 10, grade_to: 12, ordinal: 3 },
]);

// ── Subject catalog (كatalog المواد الدراسية) ──
// `branch` is NULL when the subject applies to all branches of the stage;
// otherwise the Egyptian secondary branches: 'SCI_SCIENCES' (علمي علوم),
// 'SCI_MATH' (علمي رياضة), 'LIT' (أدبي). `ordinal` is a stable display order
// inside (stage_code, branch).
const SUBJECTS = Object.freeze([
  // Primary (P) — all branches of stage P
  { code: 'P-AR',   name_ar: 'اللغة العربية',       stage: 'P', branch: null, ord: 1 },
  { code: 'P-EN',   name_ar: 'اللغة الإنجليزية',     stage: 'P', branch: null, ord: 2 },
  { code: 'P-MATH', name_ar: 'الرياضيات',           stage: 'P', branch: null, ord: 3 },
  { code: 'P-SCI',  name_ar: 'العلوم',              stage: 'P', branch: null, ord: 4 },
  { code: 'P-SOC',  name_ar: 'الدراسات الاجتماعية', stage: 'P', branch: null, ord: 5 },
  { code: 'P-REL',  name_ar: 'التربية الدينية',     stage: 'P', branch: null, ord: 6 },
  { code: 'P-CIV',  name_ar: 'التربية الوطنية',     stage: 'P', branch: null, ord: 7 },
  { code: 'P-CS',   name_ar: 'الحاسب الآلي',        stage: 'P', branch: null, ord: 8 },
  { code: 'P-ART',  name_ar: 'التربية الفنية',      stage: 'P', branch: null, ord: 9 },
  { code: 'P-MUS',  name_ar: 'التربية الموسيقية',   stage: 'P', branch: null, ord: 10 },
  { code: 'P-PE',   name_ar: 'التربية الرياضية',    stage: 'P', branch: null, ord: 11 },
  // Preparatory (PR) — all branches of stage PR
  { code: 'PR-AR',   name_ar: 'اللغة العربية',       stage: 'PR', branch: null, ord: 1 },
  { code: 'PR-EN',   name_ar: 'اللغة الإنجليزية',     stage: 'PR', branch: null, ord: 2 },
  { code: 'PR-MATH', name_ar: 'الرياضيات',           stage: 'PR', branch: null, ord: 3 },
  { code: 'PR-SCI',  name_ar: 'العلوم',              stage: 'PR', branch: null, ord: 4 },
  { code: 'PR-GEO',  name_ar: 'الجغرافيا',           stage: 'PR', branch: null, ord: 5 },
  { code: 'PR-HIST', name_ar: 'التاريخ',            stage: 'PR', branch: null, ord: 6 },
  { code: 'PR-REL',  name_ar: 'التربية الدينية',     stage: 'PR', branch: null, ord: 7 },
  { code: 'PR-CIV',  name_ar: 'التربية الوطنية',     stage: 'PR', branch: null, ord: 8 },
  { code: 'PR-CS',   name_ar: 'الحاسب الآلي',        stage: 'PR', branch: null, ord: 9 },
  { code: 'PR-ART',  name_ar: 'التربية الفنية',      stage: 'PR', branch: null, ord: 10 },
  { code: 'PR-MUS',  name_ar: 'التربية الموسيقية',   stage: 'PR', branch: null, ord: 11 },
  { code: 'PR-PE',   name_ar: 'التربية الرياضية',    stage: 'PR', branch: null, ord: 12 },
  { code: 'PR-AGRI', name_ar: 'المجال الزراعي',      stage: 'PR', branch: null, ord: 13 },
  { code: 'PR-IND',  name_ar: 'المجال الصناعي',      stage: 'PR', branch: null, ord: 14 },
  { code: 'PR-COMM', name_ar: 'المجال التجاري',      stage: 'PR', branch: null, ord: 15 },
  { code: 'PR-HE',   name_ar: 'الاقتصاد المنزلي',    stage: 'PR', branch: null, ord: 16 },
  // Secondary (S) — common to all branches of stage S
  { code: 'S-AR',    name_ar: 'اللغة العربية',          stage: 'S', branch: null,        ord: 1 },
  { code: 'S-EN',    name_ar: 'اللغة الإنجليزية (الأولى)', stage: 'S', branch: null,        ord: 2 },
  { code: 'S-EN2',   name_ar: 'اللغة الأجنبية الثانية',  stage: 'S', branch: null,        ord: 3 },
  { code: 'S-REL',   name_ar: 'التربية الدينية',        stage: 'S', branch: null,        ord: 4 },
  { code: 'S-CIV',   name_ar: 'التربية الوطنية',        stage: 'S', branch: null,        ord: 5 },
  // Secondary — Scientific Sciences branch (علمي علوم)
  { code: 'S-SCI-BIO',  name_ar: 'الأحياء',           stage: 'S', branch: 'SCI_SCIENCES', ord: 11 },
  { code: 'S-SCI-PHY',  name_ar: 'الفيزياء',          stage: 'S', branch: 'SCI_SCIENCES', ord: 12 },
  { code: 'S-SCI-CHEM', name_ar: 'الكيمياء',          stage: 'S', branch: 'SCI_SCIENCES', ord: 13 },
  { code: 'S-SCI-GEOL', name_ar: 'الجيولوجيا والفلك',  stage: 'S', branch: 'SCI_SCIENCES', ord: 14 },
  { code: 'S-SCI-MATH', name_ar: 'الرياضيات',         stage: 'S', branch: 'SCI_SCIENCES', ord: 15 },
  { code: 'S-SCI-ES',   name_ar: 'الاقتصاد والإحصاء',  stage: 'S', branch: 'SCI_SCIENCES', ord: 16 },
  // Secondary — Scientific Math branch (علمي رياضة)
  { code: 'S-MATH-MATH', name_ar: 'الرياضيات (مستوى رفيع)', stage: 'S', branch: 'SCI_MATH', ord: 11 },
  { code: 'S-MATH-PHY',  name_ar: 'الفيزياء',              stage: 'S', branch: 'SCI_MATH', ord: 12 },
  { code: 'S-MATH-CHEM', name_ar: 'الكيمياء',              stage: 'S', branch: 'SCI_MATH', ord: 13 },
  { code: 'S-MATH-BIO',  name_ar: 'الأحياء',               stage: 'S', branch: 'SCI_MATH', ord: 14 },
  { code: 'S-MATH-ES',   name_ar: 'الاقتصاد والإحصاء',     stage: 'S', branch: 'SCI_MATH', ord: 15 },
  // Secondary — Literary branch (أدبي)
  { code: 'S-LIT-HIST', name_ar: 'التاريخ',            stage: 'S', branch: 'LIT', ord: 11 },
  { code: 'S-LIT-GEO',  name_ar: 'الجغرافيا',          stage: 'S', branch: 'LIT', ord: 12 },
  { code: 'S-LIT-PHIL', name_ar: 'الفلسفة والمنطق',    stage: 'S', branch: 'LIT', ord: 13 },
  { code: 'S-LIT-PSY',  name_ar: 'علم النفس والاجتماع', stage: 'S', branch: 'LIT', ord: 14 },
  { code: 'S-LIT-ECO',  name_ar: 'الاقتصاد',           stage: 'S', branch: 'LIT', ord: 15 },
]);

// ── School terms (فصول الدراسة) ──
// The Egyptian school year is two-term; mid-year exam ends T1, end-of-year
// exam ends T2. Thanaweya Amma (الثانوية العامة) capstone is the T2 grade-12
// national exam.
const SCHOOL_TERMS = Object.freeze([
  { code: 'T1', name_ar: 'الترم الأول', ordinal: 1 },
  { code: 'T2', name_ar: 'الترم الثاني', ordinal: 2 },
]);

module.exports = Object.freeze({
  DIRECTORATES,
  EDUCATION_STAGES,
  SUBJECTS,
  SCHOOL_TERMS,
});
