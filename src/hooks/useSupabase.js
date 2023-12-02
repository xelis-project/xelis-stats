import { createClient } from '@supabase/supabase-js'

const supabaseUrl = INDEX_REST_ENDPOINT
const supabaseKey = INDEX_REST_KEY

let supabase = {}

try {
  supabase = createClient(supabaseUrl, supabaseKey)
} catch (err) {
  console.log(err)
}

export default supabase
