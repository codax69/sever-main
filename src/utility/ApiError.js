class ApiError extends Error{
    constructor(
        statusCode,
        message = "Something Went Wrong..!",
        errors = [],
        stack = ""
    ){
        super(message)
        this.data = null
        // keep original property for backward compatibility
        this.statuscode = statusCode
        // standard properties expected by many middlewares
        this.status = statusCode
        this.statusCode = statusCode
        this.message = message
        this.success = false
        this.errors = errors

        if(stack){
            this.stack = stack
        }else{
            Error.captureStackTrace(this,this.constructor)
        }
    }
}
export {ApiError}