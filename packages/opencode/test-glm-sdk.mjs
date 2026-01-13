import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

console.log('Creating SDK with custom fetch (fixed baseURL)...')

const sdk = createOpenAICompatible({
  name: 'glm-vertex',
  baseURL: 'https://aiplatform.googleapis.com/v1/projects/spotlessbinco/locations/global/endpoints/openapi',
  fetch: async (input, init) => {
    console.log('Custom fetch called!')
    console.log('URL:', input)
    const { stdout } = await execAsync('gcloud auth print-access-token')
    const token = stdout.trim()
    console.log('Got token:', token.substring(0, 20) + '...')
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers })
  }
})

console.log('SDK created, now getting model...')
const model = sdk('zai-org/glm-4.7-maas')

console.log('Model obtained, calling doGenerate...')
try {
  const result = await model.doGenerate({
    inputFormat: 'messages',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] }]
  })
  console.log('Success! Result:', result.text)
} catch (error) {
  console.error('Error:', error.message)
  console.error('Stack:', error.stack)
}
