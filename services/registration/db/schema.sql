-- =====================================================================
-- HaderApp (Group 40) - Step 2: shared profiles + Registration Service tables
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
-- =====================================================================

-- 1) PROFILES (shared by all three services)
-- Supabase Auth keeps logins in auth.users. This table adds each user's name and ROLE.
-- The role is NOT taken from the sign-up form, so nobody can make themselves an organizer.
CREATE TABLE public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL DEFAULT '',
  role        VARCHAR(20)  NOT NULL DEFAULT 'attendee'
                CHECK (role IN ('organizer', 'attendee')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Every new sign-up automatically gets a profile with role = attendee.
-- Organizers are promoted by hand (see the note at the end).
CREATE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, name)
  VALUES (NEW.id, COALESCE(LEFT(NEW.raw_user_meta_data ->> 'name', 100), ''));
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2) WORKSHOPS (Registration Service - Nourhan)
CREATE TABLE public.workshops (
  workshop_id    SERIAL PRIMARY KEY,
  title          VARCHAR(100)  NOT NULL,
  description    VARCHAR(1000) NOT NULL DEFAULT '',
  workshop_date  TIMESTAMPTZ   NOT NULL,
  total_seats    INTEGER       NOT NULL CHECK (total_seats BETWEEN 1 AND 1000),
  seats_left     INTEGER       NOT NULL CHECK (seats_left >= 0),
  organizer_id   UUID          NOT NULL REFERENCES public.profiles(id),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT seats_left_not_above_total CHECK (seats_left <= total_seats)
);

-- 3) REGISTRATIONS (Registration Service - Nourhan)
-- Cancelling deletes the row, so the attendee can register again later.
CREATE TABLE public.registrations (
  registration_id  SERIAL PRIMARY KEY,
  workshop_id      INTEGER     NOT NULL REFERENCES public.workshops(workshop_id) ON DELETE CASCADE,
  attendee_id      UUID        NOT NULL REFERENCES public.profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_registration_per_attendee UNIQUE (workshop_id, attendee_id)
);

CREATE INDEX idx_workshops_organizer     ON public.workshops(organizer_id);
CREATE INDEX idx_registrations_attendee  ON public.registrations(attendee_id);

-- 4) SECURITY: Row Level Security ON, with no policies.
-- This blocks the browser (Supabase public key) from reading or changing these tables
-- directly. Only our backend, which connects with the database connection string, can.
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshops     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registrations ENABLE ROW LEVEL SECURITY;

-- 5) SECURITY: block direct calls to the automatic sign-up function (Security Advisor fix)
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- To make someone an organizer (run separately, after they have signed up):
--   UPDATE public.profiles SET role = 'organizer'
--   WHERE id = (SELECT id FROM auth.users WHERE email = 'organizer@example.com');
-- ---------------------------------------------------------------------
